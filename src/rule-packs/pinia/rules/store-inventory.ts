import { relative } from "pathe";
import type { NuxtProjectInfo, RuleContext, SourceRange } from "../../../core/index.js";
import { analyzeScript, type ScriptScope } from "../../../core/internal/script-scope.js";
import { ownPropertyName } from "../../../core/internal/shared-state-writes.js";
import { createVueScriptForParsing, parseSfcFile } from "../../../core/internal/sfc.js";
import {
  collectStoreModules,
  isPiniaSource,
  isTransformedAppFile,
  nuxtForFile,
  readStoreDefinition,
  resolvedCalleeImport,
  storeResolver,
  type LocatedStore,
  type SetupStoreUseTarget,
  type StoreModule,
} from "./shared.js";

export type AnyNode = any;

/** How Pinia exposes a store key: `createSetupStore()` sorts setup results the same way. */
export type StoreKeyKind = "state" | "getter" | "action";

export interface StoreInventory {
  kind: "option" | "setup";
  /** Keys whose kind Doctor established, with the node that declares each one. */
  keys: Map<string, { kind: StoreKeyKind; node: AnyNode }>;
  /** Why the listing may be incomplete, such as a spread Doctor cannot read. */
  gap?: string;
}

export interface CollectedStore {
  located: LocatedStore;
  scope: ScriptScope;
  /** The `defineStore()` call. */
  call: AnyNode;
  /** The names other modules import the store under. */
  exportNames: string[];
  inventory: StoreInventory;
}

export interface StoreCollection {
  stores: CollectedStore[];
  /** `defineStore()` call ranges in each store module. */
  storeCalls: Map<string, Array<[number, number]>>;
  /** Scope analyses of the store modules, by file. */
  scopes: Map<string, AnalyzedSource>;
  resolveUse: ReturnType<typeof storeResolver>["resolveUse"];
  registeredNames: ReturnType<typeof storeResolver>["registeredNames"];
  byLocated: Map<LocatedStore, CollectedStore>;
}

export interface AnalyzedSource {
  scope: ScriptScope;
  /** Offsets of the SFC `<script setup>` block. */
  scriptSetup?: [number, number];
  /** Offsets of the SFC `<script>` block. */
  script?: [number, number];
}

/** Where code runs relative to Vue's and Pinia's injection context. */
export type CallContext =
  /** Synchronously in `<script setup>`, a component's `setup()`, or a setup store's function. */
  | "setup"
  /** While the module evaluates: a module's top level or an SFC's plain `<script>`. */
  | "module"
  | "other";

export interface StoreCall {
  file: string;
  text: string;
  source: AnalyzedSource;
  call: AnyNode;
  store: CollectedStore;
  /** Matched to the only store exported under the called name, with no import to follow. */
  byName: boolean;
  context: CallContext;
  parents: WeakMap<AnyNode, AnyNode>;
  /** Where another node of the same file runs. */
  contextOf(node: AnyNode): CallContext;
}

const WRAPPERS = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
export const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const DEFERRED = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ClassBody",
]);
const STATE_FACTORIES = new Map<string, "ref" | "reactive">([
  ["ref", "ref"],
  ["shallowRef", "ref"],
  ["reactive", "reactive"],
  ["shallowReactive", "reactive"],
]);
const VUE_SOURCES = new Set(["vue", "@vue/reactivity"]);

/** Every `defineStore()` call in the run, with what each store exposes. */
export async function collectStores(ctx: RuleContext): Promise<StoreCollection> {
  const factoryAliases = new Map<NuxtProjectInfo, string[]>();
  const modules = await collectStoreModules(
    ctx,
    await ctx.inventory.sourcePaths(),
    (file, text) => {
      if (text.includes("defineStore")) return true;
      const nuxt = nuxtForFile(ctx, file);
      if (!nuxt?.autoImportsAuthoritative) return false;
      let aliases = factoryAliases.get(nuxt);
      if (!aliases) {
        aliases = [...nuxt.autoImports].flatMap(([name, entry]) =>
          !entry.type && entry.name === "defineStore" && isPiniaSource(entry.from) ? [name] : [],
        );
        factoryAliases.set(nuxt, aliases);
      }
      return aliases.some((name) => text.includes(name));
    },
  );
  const storeCalls = new Map<string, Array<[number, number]>>();
  const scopes = new Map<string, AnalyzedSource>();
  const located: LocatedStore[] = [];
  const stores: CollectedStore[] = [];
  for (const module of modules) {
    const source = await analyzeSource(module.file, module.text);
    if (!source) continue;
    const { scope } = source;
    scopes.set(module.file, source);
    const ranges: Array<[number, number]> = [];
    storeCalls.set(module.file, ranges);
    const nuxt = nuxtForFile(ctx, module.file);
    const implicit = implicitImportsEnabled(ctx, module.file);
    walk(scope, scope.ast, (call, ancestors) => {
      if (call.type !== "CallExpression" || !isDefineStoreCall(call, scope, nuxt, implicit)) return;
      ranges.push(call.range);
      const definition = readStoreDefinition(call, ancestors);
      if (!definition) return;
      const store: LocatedStore = { store: definition, module };
      located.push(store);
      stores.push({
        located: store,
        scope,
        call,
        exportNames: storeExportNames(scope, store, call),
        inventory: readInventory(ctx, module, scope, call),
      });
    });
  }
  const { resolveUse, registeredNames } = storeResolver(ctx, located);
  return {
    stores,
    storeCalls,
    scopes,
    resolveUse,
    registeredNames,
    byLocated: new Map(stores.map((store) => [store.located, store])),
  };
}

export async function analyzeSource(file: string, text: string): Promise<AnalyzedSource | null> {
  if (!file.endsWith(".vue")) {
    const scope = analyzeScript(text, /\.[jt]sx$/.test(file) ? "tsx" : "ts");
    return scope && { scope };
  }
  const { descriptor } = await parseSfcFile(file, text);
  const script = createVueScriptForParsing(descriptor, text);
  const scope = analyzeScript(
    script.text,
    script.lang === "jsx" || script.lang === "tsx" ? "tsx" : "ts",
  );
  const range = (block: AnyNode): [number, number] | undefined =>
    block?.loc ? [block.loc.start.offset, block.loc.end.offset] : undefined;
  return (
    scope && {
      scope,
      scriptSetup: range(descriptor?.scriptSetup),
      script: range(descriptor?.script),
    }
  );
}

function isDefineStoreCall(
  call: AnyNode,
  scope: ScriptScope,
  nuxt: NuxtProjectInfo | undefined,
  implicit: boolean,
): boolean {
  const callee = unwrap(call.callee);
  const binding = calleeBinding(callee, scope, nuxt, implicit);
  if (binding) return binding.name === "defineStore" && isPiniaSource(binding.from);
  return (
    implicit &&
    !nuxt?.autoImportsAuthoritative &&
    !nuxt?.autoImports.has("defineStore") &&
    callee?.type === "Identifier" &&
    callee.name === "defineStore" &&
    scope.references.get(callee)?.resolved === null
  );
}

/** Whether identifiers with no declaration in `file` can be auto-imports. */
export function implicitImportsEnabled(ctx: RuleContext, file: string): boolean {
  const nuxt = nuxtForFile(ctx, file);
  return (
    !nuxt ||
    (nuxt.autoImportEnabled && isTransformedAppFile(file, relative(ctx.project.root, file), nuxt))
  );
}

export function calleeBinding(
  callee: AnyNode,
  scope: ScriptScope,
  nuxt: ReturnType<typeof nuxtForFile>,
  implicit: boolean,
) {
  return resolvedCalleeImport(
    callee,
    (identifier) => {
      const reference = scope.references.get(identifier);
      return implicit || reference?.resolved ? reference : undefined;
    },
    nuxt,
  );
}

/** The Vue API `init` calls, imported or auto-imported, such as `ref` or `computed`. */
export function vueApiCall(
  ctx: RuleContext,
  file: string,
  scope: ScriptScope,
  init: AnyNode,
): string | undefined {
  if (init?.type !== "CallExpression") return undefined;
  const callee = unwrap(init.callee);
  const nuxt = nuxtForFile(ctx, file);
  const implicit = implicitImportsEnabled(ctx, file);
  const binding = calleeBinding(callee, scope, nuxt, implicit);
  if (binding) return VUE_SOURCES.has(binding.from) ? binding.name : undefined;
  if (
    implicit &&
    !nuxt?.autoImportsAuthoritative &&
    callee?.type === "Identifier" &&
    scope.references.get(callee)?.resolved === null &&
    !nuxt?.autoImports.has(callee.name)
  )
    return callee.name;
  return undefined;
}

/** `ref()` or `reactive()` from Vue, imported or auto-imported. */
export function stateFactory(
  ctx: RuleContext,
  file: string,
  scope: ScriptScope,
  init: AnyNode,
): "ref" | "reactive" | undefined {
  const api = vueApiCall(ctx, file, scope, init);
  return api ? STATE_FACTORIES.get(api) : undefined;
}

function readInventory(
  ctx: RuleContext,
  module: StoreModule,
  scope: ScriptScope,
  call: AnyNode,
): StoreInventory {
  const setup = unwrap(call.arguments[1]);
  const first = unwrap(call.arguments[0]);
  if (first?.type !== "ObjectExpression" && FUNCTIONS.has(setup?.type))
    return setupInventory(ctx, module.file, scope, setup);
  const options = first?.type === "ObjectExpression" ? first : setup;
  const inventory: StoreInventory = { kind: "option", keys: new Map() };
  if (options?.type !== "ObjectExpression") {
    inventory.gap = "Doctor cannot read the store options";
    return inventory;
  }
  const read = readProperties(options);
  const gaps: string[] = read.complete ? [] : ["the store options use a spread or computed key"];
  for (const [option, kind] of [
    ["state", "state"],
    ["actions", "action"],
    ["getters", "getter"],
  ] as const) {
    const value = read.properties.get(option);
    if (!value) {
      if (!read.complete) inventory.keys.clear();
      continue;
    }
    const properties = readProperties(
      option === "state" ? returnedObject(scope, value.value) : value.value,
    );
    if (!properties.complete) {
      gaps.push(`Doctor cannot read every key of ${option}`);
      inventory.keys.clear();
    }
    for (const [name, property] of properties.properties)
      inventory.keys.set(name, { kind, node: property.key });
  }
  if (gaps.length) inventory.gap = gaps.join("; ");
  return inventory;
}

/**
 * Classifies a setup store's returned keys the way Pinia's `createSetupStore()` does: refs that
 * are not computed and reactive objects are state, functions are actions, and computed refs are
 * getters.
 */
function setupInventory(
  ctx: RuleContext,
  file: string,
  scope: ScriptScope,
  setup: AnyNode,
): StoreInventory {
  const inventory: StoreInventory = { kind: "setup", keys: new Map() };
  const returned = setupReturn(scope, setup);
  if (!returned) {
    inventory.gap = "Doctor cannot read the object the setup function returns";
    return inventory;
  }
  const read = readProperties(returned);
  if (!read.complete) inventory.gap = "the returned object uses a spread or computed key";
  for (const [name, property] of read.properties) {
    if (property.kind !== "init") continue;
    let value = unwrap(property.value);
    let node = property.key;
    if (value?.type === "Identifier") {
      const variable = scope.references.get(value)?.resolved;
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (definition?.type === "FunctionName") {
        inventory.keys.set(name, { kind: "action", node: definition.name });
        continue;
      }
      if (definition?.type !== "Variable" || definition.parent?.kind !== "const") continue;
      value = unwrap(definition.node.init);
      node = definition.name;
    }
    const kind = FUNCTIONS.has(value?.type) ? "action" : valueKind(ctx, file, scope, value);
    if (kind) inventory.keys.set(name, { kind, node });
  }
  return inventory;
}

function valueKind(
  ctx: RuleContext,
  file: string,
  scope: ScriptScope,
  value: AnyNode,
): StoreKeyKind | undefined {
  const api = vueApiCall(ctx, file, scope, value);
  if (api === "computed") return "getter";
  return api && STATE_FACTORIES.has(api) ? "state" : undefined;
}

/**
 * The object literal a setup function returns, or none when it may return something else: an
 * expression Doctor cannot read, or an early `return`.
 */
export function setupReturn(scope: ScriptScope, setup: AnyNode): AnyNode {
  if (setup.body?.type !== "BlockStatement") {
    const body = unwrap(setup.body);
    return body?.type === "ObjectExpression" ? body : undefined;
  }
  const last = setup.body.body.at(-1);
  if (last?.type !== "ReturnStatement") return undefined;
  let returns = 0;
  walk(scope, setup.body, (node) => {
    if (DEFERRED.has(node.type) || node.type === "ClassDeclaration") return false;
    if (node.type === "ReturnStatement") returns++;
  });
  const object = unwrap(last.argument);
  return returns === 1 && object?.type === "ObjectExpression" ? object : undefined;
}

/** The object literal a state function returns, as with `state: () => ({ ... })`. */
export function returnedObject(scope: ScriptScope, value: AnyNode): AnyNode {
  const fn = unwrap(value);
  return FUNCTIONS.has(fn?.type) ? setupReturn(scope, fn) : undefined;
}

/**
 * The properties an object literal ends up with. A spread of something other than an object
 * literal, or a computed key, can replace any earlier key, so it drops them and marks the result
 * incomplete.
 */
export function readProperties(node: AnyNode): {
  properties: Map<string, AnyNode>;
  complete: boolean;
} {
  const properties = new Map<string, AnyNode>();
  let complete = true;
  function collect(value: AnyNode) {
    const object = unwrap(value);
    if (object?.type !== "ObjectExpression") {
      properties.clear();
      complete = false;
      return;
    }
    for (const property of object.properties) {
      if (property.type === "SpreadElement") collect(property.argument);
      else {
        const name = ownPropertyName(property);
        if (name !== null) properties.set(name, property);
        else if (property.computed) {
          properties.clear();
          complete = false;
        }
      }
    }
  }
  collect(node);
  return { properties, complete };
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

/**
 * Calls to project stores in the run's source files, resolved to their definitions the same way
 * setup-store cycles resolve them, with where each call runs.
 */
export async function findStoreCalls(
  ctx: RuleContext,
  collection: StoreCollection,
): Promise<StoreCall[]> {
  const names = new Set<string>();
  for (const store of collection.stores)
    for (const name of store.exportNames) if (name !== "default") names.add(name);
  for (const nuxt of [ctx.project.nuxt, ...(ctx.project.workspaceNuxt ?? []).map((i) => i.nuxt)])
    for (const [name, entry] of nuxt?.autoImports ?? []) if (!entry.type) names.add(name);
  const pattern = names.size ? new RegExp([...names].map(escapeRegExp).join("|")) : undefined;
  const { resolveUse, prepareUse } = storeResolver(
    ctx,
    collection.stores.map(({ located }) => located),
    undefined,
    true,
  );
  const calls: StoreCall[] = [];
  for (const file of await ctx.inventory.sourcePaths()) {
    if (/\.mdc?$/.test(file)) continue;
    const text = ctx.fs.readText(file);
    const cached = collection.scopes.get(file);
    if (!text || (!cached && !text.includes("import") && !pattern?.test(text))) continue;
    const source = cached ?? (await analyzeSource(file, text));
    if (!source) continue;
    const { scope } = source;
    const implicit = implicitImportsEnabled(ctx, file);
    const local = new Map(
      collection.stores
        .filter((store) => store.located.module.file === file && store.located.store.binding)
        .map((store) => [store.located.store.binding!.start, store]),
    );
    const setups = new Set(
      collection.stores
        .filter((store) => store.located.module.file === file && store.located.store.setup)
        .map((store) => unwrap(store.call.arguments[1])),
    );
    const parents = new WeakMap<AnyNode, AnyNode>();
    const contextOf = (node: AnyNode) =>
      callContext(node, parents, source, setups, (fn) =>
        isComponentSetup(ctx, file, source, fn, parents),
      );
    const uses: Array<{ node: AnyNode; target: SetupStoreUseTarget }> = [];
    walk(scope, scope.ast, (node, ancestors) => {
      if (ancestors.length) parents.set(node, ancestors.at(-1));
      if (node.type !== "CallExpression") return;
      const callee = unwrap(node.callee);
      const target = useTarget(scope, callee, local, implicit ? names : undefined);
      if (target) uses.push({ node, target });
    });
    for (const { node, target } of uses) {
      await prepareUse(file, target);
      const resolved = resolveUse(file, target);
      const store = resolved && collection.byLocated.get(resolved.store);
      if (!store) continue;
      calls.push({
        file,
        text,
        source,
        call: node,
        store,
        byName: resolved.byName,
        context: contextOf(node),
        parents,
        contextOf,
      });
    }
  }
  return calls;
}

function useTarget(
  scope: ScriptScope,
  callee: AnyNode,
  local: Map<number, CollectedStore>,
  implicitNames: Set<string> | undefined,
): SetupStoreUseTarget | undefined {
  const member = callee?.type === "MemberExpression";
  const identifier = member ? unwrap(callee.object) : callee;
  if (identifier?.type !== "Identifier") return undefined;
  const reference = scope.references.get(identifier);
  if (!reference?.isValueReference) return undefined;
  const variable = reference.resolved;
  if (!variable) {
    if (member || !implicitNames?.has(identifier.name)) return undefined;
    return { kind: "auto-import", name: identifier.name };
  }
  if (variable.defs.length !== 1) return undefined;
  const definition = variable.defs[0];
  if (
    definition.type === "ImportBinding" &&
    definition.parent.type === "ImportDeclaration" &&
    definition.parent.importKind !== "type"
  ) {
    const binding = definition.node;
    let name: string | undefined;
    if (member && binding.type === "ImportNamespaceSpecifier") {
      if (!callee.computed) name = callee.property.name;
      else if (typeof callee.property.value === "string") name = callee.property.value;
    } else if (!member && binding.type === "ImportDefaultSpecifier") name = "default";
    else if (!member && binding.type === "ImportSpecifier" && binding.importKind !== "type")
      name = exportedName(binding.imported);
    if (name !== undefined)
      return { kind: "import", name, source: String(definition.parent.source.value) };
  }
  if (
    !member &&
    definition.type === "Variable" &&
    definition.parent.kind === "const" &&
    local.has(definition.name.range[0])
  )
    return { kind: "local", start: definition.name.range[0] };
  return undefined;
}

/** Where `node` runs: the innermost function or class around it decides. */
function callContext(
  node: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  source: AnalyzedSource,
  setups: Set<AnyNode>,
  componentSetup: (fn: AnyNode) => boolean,
): CallContext {
  for (let parent = parents.get(node); parent; parent = parents.get(parent)) {
    if (!DEFERRED.has(parent.type) && parent.type !== "StaticBlock") continue;
    return setups.has(parent) || componentSetup(parent) ? "setup" : "other";
  }
  const offset = node.range[0];
  if (!source.script && !source.scriptSetup) return "module";
  if (within(offset, source.scriptSetup)) return "setup";
  return within(offset, source.script) ? "module" : "other";
}

function within(offset: number, range: [number, number] | undefined) {
  return range !== undefined && offset >= range[0] && offset < range[1];
}

function isComponentSetup(
  ctx: RuleContext,
  file: string,
  source: AnalyzedSource,
  fn: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
): boolean {
  if (!FUNCTIONS.has(fn.type)) return false;
  const { expression, parent } = enclosing(fn, parents);
  const isDefineComponent = (node: AnyNode) => {
    const nuxt = nuxtForFile(ctx, file);
    const binding = calleeBinding(
      unwrap(node.callee),
      source.scope,
      nuxt,
      implicitImportsEnabled(ctx, file),
    );
    return binding
      ? binding.from === "vue" && binding.name === "defineComponent"
      : Boolean(nuxt) && vueApiCall(ctx, file, source.scope, node) === "defineComponent";
  };
  if (parent?.type === "CallExpression")
    return parent.arguments[0] === expression && isDefineComponent(parent);
  if (parent?.type !== "Property" || parent.value !== expression || parent.kind !== "init")
    return false;
  if (ownPropertyName(parent) !== "setup") return false;
  const options = parents.get(parent);
  if (
    options?.type !== "ObjectExpression" ||
    readProperties(options).properties.get("setup") !== parent
  )
    return false;
  const owner = enclosing(options, parents);
  if (owner.parent?.type === "CallExpression")
    return owner.parent.arguments[0] === owner.expression && isDefineComponent(owner.parent);
  return within(fn.range[0], source.script) && owner.parent?.type === "ExportDefaultDeclaration";
}

/** The outermost transparent wrapper around `node` and the node that contains it. */
export function enclosing(
  node: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
): { expression: AnyNode; parent: AnyNode } {
  let expression = node;
  let parent = parents.get(node);
  while (parent && WRAPPERS.has(parent.type)) {
    expression = parent;
    parent = parents.get(parent);
  }
  return { expression, parent };
}

export function storeRange(ctx: RuleContext, file: string, text: string, node: AnyNode) {
  return ctx.helpers.rangeFromOffsets(file, text, node.range[0], node.range[1]) as SourceRange;
}

export function exportedName(node: AnyNode): string {
  return node?.type === "Identifier" ? node.name : String(node?.value);
}

export function unwrap(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

export function walk(
  scope: ScriptScope,
  node: AnyNode,
  visit: (node: AnyNode, ancestors: AnyNode[]) => boolean | void,
  ancestors: AnyNode[] = [],
) {
  if (!node || typeof node.type !== "string" || visit(node, ancestors) === false) return;
  ancestors.push(node);
  for (const key of scope.visitorKeys[node.type] ?? []) {
    const value = node[key];
    for (const child of Array.isArray(value) ? value : [value])
      walk(scope, child, visit, ancestors);
  }
  ancestors.pop();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
