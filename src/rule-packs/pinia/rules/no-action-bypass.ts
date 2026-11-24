import { relative } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { analyzeScript, type ScriptScope } from "../../../core/internal/script-scope.js";
import { createVueScriptForParsing, parseSfcFile } from "../../../core/internal/sfc.js";
import {
  findLocalStateWrites,
  findSharedStateWrites,
  findThisWrites,
  stateCollections,
  type PropertyPath,
  type SharedStateWrite,
} from "../../../core/internal/shared-state-writes.js";
import { diagnostics } from "../diagnostics.js";
import {
  collectStoreModules,
  findStoreDefinitions,
  storeResolver,
  type LocatedStore,
  type StoreModule,
} from "./shared.js";

type AnyNode = any;
type CollectionAt = (path: PropertyPath) => "array" | "map" | "set" | undefined;

const RULE_ID = "pinia/state/no-action-bypass";
const MAX_LISTED_WRITES = 3;
const WRAPPERS = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const STATE_FACTORIES = new Map<string, "ref" | "reactive">([
  ["ref", "ref"],
  ["shallowRef", "ref"],
  ["reactive", "reactive"],
  ["shallowReactive", "reactive"],
]);
const VUE_SOURCES = new Set(["vue", "@vue/reactivity", "#imports"]);

interface StoreState {
  /** The node Diagnostics point at: the state key or the setup variable. */
  declaration: AnyNode;
  /** Actions that write this property, by the name the store exposes them under. */
  actions: Set<string>;
}

interface AnalyzedStore {
  located: LocatedStore;
  kind: "option" | "setup";
  exportNames: string[];
  state: Map<string, StoreState>;
  collectionAt: CollectionAt;
}

export const noActionBypass = createRule({
  meta: {
    id: RULE_ID,
    title: "Write store state through the action that already writes it",
    description:
      "Report Pinia state that the store's own action writes, yet two or more other files write directly.",
    why: "Pinia lets any component write store state, but an action that already writes a property shows that the store author meant changes to go through it. When several components write the same property directly, the changes are scattered across files and skip whatever the action enforces, such as validation, derived bookkeeping, or persistence.",
    recommendedReplacement:
      "Call the store's existing action from the components, or add an action for a change it does not cover yet, such as a reset. Keep the property in the store's state; do not copy it into components.",
    examples: [
      {
        title: "Change state through the store's action",
        language: "vue",
        invalid:
          '<!-- stores/cart.ts -->\nexport const useCartStore = defineStore(\'cart\', () => {\n  const items = ref<string[]>([])\n  function addItem(item: string) {\n    items.value.push(item)\n  }\n  return { items, addItem }\n})\n\n<!-- AddButton.vue and ClearButton.vue -->\n<script setup lang="ts">\nconst cart = useCartStore()\n</script>\n\n<template>\n  <button @click="cart.items.push(\'apple\')">Add</button>\n  <button @click="cart.items = []">Clear</button>\n</template>',
        valid:
          '<!-- stores/cart.ts -->\nexport const useCartStore = defineStore(\'cart\', () => {\n  const items = ref<string[]>([])\n  function addItem(item: string) {\n    items.value.push(item)\n  }\n  function clear() {\n    items.value = []\n  }\n  return { items, addItem, clear }\n})\n\n<!-- AddButton.vue and ClearButton.vue -->\n<script setup lang="ts">\nconst cart = useCartStore()\n</script>\n\n<template>\n  <button @click="cart.addItem(\'apple\')">Add</button>\n  <button @click="cart.clear()">Clear</button>\n</template>',
      },
    ],
    category: "state",
    severity: "info",
    confidence: "heuristic-high",
    fixable: false,
    diagnosticCodes: ["PINIA0004"],
    docsUrl: "https://pinia.vuejs.org/core-concepts/actions.html",
    execution: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast", "graph"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const modules = await collectStoreModules(ctx);
        const located = modules.flatMap((module) =>
          findStoreDefinitions(module.program, module.text).map((store) => ({ store, module })),
        );
        if (!located.length) return;
        const resolve = storeResolver(ctx, located);
        const storeCalls = new Map<string, Array<[number, number]>>();
        const stores: AnalyzedStore[] = [];
        for (const module of modules) {
          const scope = await analyzeModule(module);
          if (!scope) continue;
          const calls = defineStoreCalls(scope);
          storeCalls.set(
            module.file,
            [...calls.values()].map((call) => call.range),
          );
          for (const store of located) {
            if (store.module !== module) continue;
            const call = calls.get(store.store.idStart);
            const analyzed = call && analyzeStore(ctx, store, scope, call);
            if (analyzed) stores.push(analyzed);
          }
        }
        const graph = await ctx.inventory.importGraph();
        for (const store of stores) {
          const byName = new Set<string>();
          const writes = new Map<string, SharedStateWrite>();
          for (const exportName of store.exportNames) {
            const found = await findSharedStateWrites(ctx, graph, {
              file: store.located.module.file,
              exportName,
              shape: "reactive",
              access: "call",
              collectionAt: store.collectionAt,
              autoImport:
                exportName === "default"
                  ? undefined
                  : (file) => {
                      const target = resolve(file, { kind: "auto-import", name: exportName });
                      if (target?.store !== store.located) return false;
                      if (target.byName) byName.add(file);
                      return true;
                    },
            });
            for (const write of found) {
              const inStore = storeCalls
                .get(write.file)
                ?.some(([start, end]) => write.range.start >= start && write.range.start < end);
              if (!inStore) writes.set(`${write.file}:${write.range.start}`, write);
            }
          }
          for (const [property, state] of store.state) {
            if (!state.actions.size) continue;
            const byFile = new Map<string, SharedStateWrite[]>();
            for (const write of writes.values()) {
              if (write.path[0] !== property) continue;
              const list = byFile.get(write.file) ?? [];
              list.push(write);
              byFile.set(write.file, list);
            }
            if (byFile.size < 2) continue;
            report(ctx, store, property, state, byFile, byName);
          }
        }
      },
    };
  },
});

async function analyzeModule(module: StoreModule): Promise<ScriptScope | null> {
  if (!module.file.endsWith(".vue"))
    return analyzeScript(module.text, /\.[jt]sx$/.test(module.file) ? "tsx" : "ts");
  const { descriptor } = await parseSfcFile(module.file, module.text);
  const script = createVueScriptForParsing(descriptor, module.text);
  return analyzeScript(script.text, script.lang === "jsx" || script.lang === "tsx" ? "tsx" : "ts");
}

/** `defineStore()`-shaped calls, keyed by the offset of their static id. */
function defineStoreCalls(scope: ScriptScope): Map<number, AnyNode> {
  const calls = new Map<number, AnyNode>();
  walk(scope, scope.ast, (node) => {
    if (node.type !== "CallExpression") return;
    const first = unwrap(node.arguments[0]);
    if (first?.type === "ObjectExpression") {
      const id = first.properties.find(
        (property: AnyNode) => property.type === "Property" && keyName(property) === "id",
      );
      if (id) calls.set(id.value.range[0], node);
    } else if (first) calls.set(first.range[0], node);
  });
  return calls;
}

function analyzeStore(
  ctx: RuleContext,
  located: LocatedStore,
  scope: ScriptScope,
  call: AnyNode,
): AnalyzedStore | undefined {
  const exportNames = storeExportNames(scope, located, call);
  if (!exportNames.length) return undefined;
  const { file, text } = located.module;
  const setup = located.store.setup && unwrap(call.arguments[1]);
  if (setup && FUNCTIONS.has(setup.type)) {
    const analyzed = analyzeSetupStore(ctx, file, text, scope, setup);
    return analyzed && { located, kind: "setup", exportNames, ...analyzed };
  }
  const first = unwrap(call.arguments[0]);
  const options = first?.type === "ObjectExpression" ? first : unwrap(call.arguments[1]);
  if (options?.type !== "ObjectExpression") return undefined;
  const analyzed = analyzeOptionStore(ctx, file, text, scope, options);
  return analyzed && { located, kind: "option", exportNames, ...analyzed };
}

function analyzeOptionStore(
  ctx: RuleContext,
  file: string,
  text: string,
  scope: ScriptScope,
  options: AnyNode,
): Pick<AnalyzedStore, "state" | "collectionAt"> | undefined {
  const literal = returnedObject(propertyValue(options, "state"));
  if (!literal) return undefined;
  const collectionAt = stateCollections(scope, literal);
  const state = new Map<string, StoreState>();
  for (const property of literal.properties) {
    const name = property.type === "Property" ? keyName(property) : undefined;
    if (name !== undefined) state.set(name, { declaration: property.key, actions: new Set() });
  }
  const actions = unwrap(propertyValue(options, "actions"));
  for (const property of actions?.type === "ObjectExpression" ? actions.properties : []) {
    const name = property.type === "Property" ? keyName(property) : undefined;
    const fn = unwrap(property.value);
    if (name === undefined || fn?.type !== "FunctionExpression") continue;
    const written = [
      ...findThisWrites(ctx, file, text, scope, fn, collectionAt).map((write) => write.path[0]),
      ...thisPatchKeys(scope, fn),
    ];
    for (const key of written) if (typeof key === "string") state.get(key)?.actions.add(name);
  }
  return { state, collectionAt };
}

function analyzeSetupStore(
  ctx: RuleContext,
  file: string,
  text: string,
  scope: ScriptScope,
  setup: AnyNode,
): Pick<AnalyzedStore, "state" | "collectionAt"> | undefined {
  if (setup.body?.type !== "BlockStatement") return undefined;
  const returned = unwrap(
    setup.body.body.findLast((statement: AnyNode) => statement.type === "ReturnStatement")
      ?.argument,
  );
  if (returned?.type !== "ObjectExpression") return undefined;
  const state = new Map<string, StoreState>();
  const collections = new Map<string, CollectionAt>();
  const actions: Array<{ name: string; range: [number, number] }> = [];
  const variables: Array<{ name: string; variable: AnyNode; shape: "ref" | "reactive" }> = [];
  for (const property of returned.properties) {
    const name = property.type === "Property" ? keyName(property) : undefined;
    if (name === undefined) continue;
    const value = unwrap(property.value);
    if (FUNCTIONS.has(value?.type)) {
      actions.push({ name, range: value.range });
      continue;
    }
    if (value?.type !== "Identifier") continue;
    const variable = scope.references.get(value)?.resolved;
    const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
    if (definition?.type === "FunctionName") {
      actions.push({ name, range: definition.node.range });
      continue;
    }
    if (definition?.type !== "Variable") continue;
    const init = unwrap(definition.node.init);
    if (FUNCTIONS.has(init?.type)) {
      actions.push({ name, range: init.range });
      continue;
    }
    const shape = stateFactory(scope, init);
    if (!shape || definition.parent?.kind !== "const") continue;
    state.set(name, { declaration: definition.name, actions: new Set() });
    collections.set(name, stateCollections(scope, init.arguments[0]));
    variables.push({ name, variable, shape });
  }
  for (const { name, variable, shape } of variables) {
    const writes = findLocalStateWrites(
      ctx,
      file,
      text,
      scope,
      variable,
      shape,
      collections.get(name)!,
    );
    for (const write of writes) {
      for (const action of actions) {
        if (write.range.start >= action.range[0] && write.range.start < action.range[1])
          state.get(name)!.actions.add(action.name);
      }
    }
  }
  return {
    state,
    collectionAt: ([name, ...rest]) =>
      typeof name === "string" ? collections.get(name)?.(rest) : undefined,
  };
}

/** `ref()` or `reactive()` from Vue, imported or auto-imported. */
function stateFactory(scope: ScriptScope, init: AnyNode): "ref" | "reactive" | undefined {
  if (init?.type !== "CallExpression" || init.callee?.type !== "Identifier") return undefined;
  const variable = scope.references.get(init.callee)?.resolved;
  if (!variable) return STATE_FACTORIES.get(init.callee.name);
  const definition: AnyNode = variable.defs.length === 1 ? variable.defs[0] : undefined;
  if (
    definition?.type !== "ImportBinding" ||
    definition.node.type !== "ImportSpecifier" ||
    !VUE_SOURCES.has(definition.parent.source.value)
  )
    return undefined;
  return STATE_FACTORIES.get(exportedName(definition.node.imported));
}

/** Keys of object literals passed to `this.$patch()` inside an option-store action. */
function thisPatchKeys(scope: ScriptScope, fn: AnyNode): string[] {
  const keys: string[] = [];
  walk(scope, fn.body, (node) => {
    if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") return false;
    const callee = node.type === "CallExpression" ? unwrap(node.callee) : undefined;
    if (callee?.type !== "MemberExpression" || callee.object?.type !== "ThisExpression") return;
    if (memberName(callee) !== "$patch") return;
    const patch = unwrap(node.arguments[0]);
    for (const property of patch?.type === "ObjectExpression" ? patch.properties : []) {
      const name = property.type === "Property" ? keyName(property) : undefined;
      if (name !== undefined) keys.push(name);
    }
  });
  return keys;
}

/** The names other modules import the store under. */
function storeExportNames(scope: ScriptScope, located: LocatedStore, call: AnyNode): string[] {
  const names = new Set<string>();
  const binding = located.store.binding;
  for (const statement of scope.ast.body as AnyNode[]) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = unwrap(statement.declaration);
      if (
        declaration === call ||
        (binding && declaration?.type === "Identifier" && declaration.name === binding.name)
      )
        names.add("default");
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type" || !binding)
      continue;
    for (const declarator of statement.declaration?.declarations ?? [])
      if (declarator.id?.range?.[0] === binding.start) names.add(binding.name);
    if (statement.source) continue;
    for (const specifier of statement.specifiers ?? [])
      if (specifier.exportKind !== "type" && exportedName(specifier.local) === binding.name)
        names.add(exportedName(specifier.exported));
  }
  return [...names];
}

function report(
  ctx: RuleContext,
  store: AnalyzedStore,
  property: string,
  state: StoreState,
  byFile: Map<string, SharedStateWrite[]>,
  byName: Set<string>,
) {
  const { file, text } = store.located.module;
  const id = store.located.store.id;
  const path = (target: string) => relative(ctx.project.root, target);
  const writes = [...byFile.values()].flat();
  const files = [...byFile].map(([target, list]) => {
    const shown = [...new Set(list.map(describeWrite))];
    const listed = shown.slice(0, MAX_LISTED_WRITES).join(", ");
    const more =
      shown.length > MAX_LISTED_WRITES ? `, and ${shown.length - MAX_LISTED_WRITES} more` : "";
    return `${path(target)} (${listed}${more})`;
  });
  const actions = [...state.actions].map((name) => `${name}()`);
  const actionList =
    actions.length === 1 ? actions[0]! : `${actions.slice(0, -1).join(", ")} or ${actions.at(-1)}`;
  const matched = [...byFile.keys()].filter((target) => byName.has(target));
  const partial = matched.length
    ? ` Doctor found no import of the store in ${matched.map(path).join(", ")}, so it matched the call to the only store exported under that name, as an auto-import from @pinia/nuxt or unplugin-auto-import would resolve it; check that no other store is auto-imported under that name.`
    : "";
  const keep =
    store.kind === "setup"
      ? `Keep "${property}" in the object the setup function returns, since Pinia requires setup stores to return all state`
      : `Keep "${property}" in the store's state`;
  const range: SourceRange = ctx.helpers.rangeFromOffsets(
    file,
    text,
    state.declaration.range[0],
    state.declaration.range[1],
  );
  ctx.report(
    diagnostics.PINIA0004({
      why: `Store "${id}" (${path(file)}) writes its "${property}" state in ${actionList}, yet ${byFile.size} other files write it directly (${writes.length} ${writes.length === 1 ? "write" : "writes"}): ${files.join("; ")}. Pinia allows direct writes, but an action that already writes "${property}" shows the store author meant changes to go through it; direct writes skip whatever the action enforces.${partial}`,
      fix: `Replace each direct write with a call to ${actionList}, or add an action to store "${id}" for a change it does not cover yet (such as a reset) and call that. ${keep}; do not copy it into components.`,
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "state",
      file,
      range,
      confidence: matched.length ? "heuristic-medium" : "heuristic-high",
      evidence: [
        {
          kind: "graph",
          file,
          range,
          summary: `"${property}" of store "${id}" is written by ${actionList} and directly in ${byFile.size} other files${matched.length ? ", some matched by exported name" : ""}.`,
        },
      ],
      related: writes.map((write) => ({
        file: write.file,
        range: write.range,
        message: `Writes ${write.target} directly${write.in === "template" ? " in the template" : ""}`,
      })),
    },
  );
}

function describeWrite(write: SharedStateWrite): string {
  const where = write.in === "template" ? " in the template" : "";
  switch (write.kind) {
    case "update":
      return `${write.target}++${where}`;
    case "delete":
      return `delete ${write.target}${where}`;
    case "mutating-call":
      return `mutates ${write.target}${where}`;
    case "v-model":
      return `v-model="${write.target}"`;
    default:
      return `${write.target} =${where}`;
  }
}

/** The object literal a state function returns, as with `state: () => ({ ... })`. */
function returnedObject(value: AnyNode): AnyNode {
  const fn = unwrap(value);
  if (!FUNCTIONS.has(fn?.type)) return undefined;
  const body =
    fn.body?.type === "BlockStatement"
      ? fn.body.body.findLast((statement: AnyNode) => statement.type === "ReturnStatement")
          ?.argument
      : fn.body;
  const literal = unwrap(body);
  return literal?.type === "ObjectExpression" ? literal : undefined;
}

function propertyValue(object: AnyNode, name: string): AnyNode {
  return object.properties.find(
    (property: AnyNode) => property.type === "Property" && keyName(property) === name,
  )?.value;
}

function keyName(property: AnyNode): string | undefined {
  const key = property.key;
  if (!property.computed && key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function memberName(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return node.property?.type === "Literal" ? String(node.property.value) : undefined;
}

function exportedName(node: AnyNode): string {
  return node?.type === "Identifier" ? node.name : String(node?.value);
}

function unwrap(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

function walk(scope: ScriptScope, node: AnyNode, visit: (node: AnyNode) => boolean | void) {
  if (!node || typeof node.type !== "string" || visit(node) === false) return;
  for (const key of scope.visitorKeys[node.type] ?? []) {
    const value = node[key];
    for (const child of Array.isArray(value) ? value : [value]) walk(scope, child, visit);
  }
}
