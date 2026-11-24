import { relative } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { analyzeScript, type ScopeVariable } from "../../../../core/internal/script-scope.js";
import {
  findLocalStateWrites,
  findSharedStateWrites,
  type SharedStateWrite,
} from "../../../../core/internal/shared-state-writes.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/state/no-external-shared-state-mutation";
const SCRIPT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const FACTORIES = new Map<string, Shape>([
  ["reactive", "reactive"],
  ["ref", "ref"],
]);
const VUE_SOURCES = new Set(["vue", "@vue/reactivity", "#imports"]);
const MAX_LISTED_WRITES = 3;

type Shape = "reactive" | "ref";

interface ExportedState {
  variable: ScopeVariable;
  id: AnyNode;
  init: AnyNode;
  shape: Shape;
  exportNames: string[];
}

interface Mutator {
  label: string;
  start: number;
  end: number;
}

export const noExternalSharedStateMutation = createRule({
  meta: {
    id: RULE_ID,
    title: "Write shared state through its module's actions",
    category: "state",
    severity: "info",
    confidence: "heuristic-high",
    fixable: false,
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast", "graph"],
    cost: "small",
    docsUrl:
      "https://vuejs.org/guide/scaling-up/state-management.html#simple-state-management-with-reactivity-api",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.importGraph();
        for (const file of graph.files) {
          if (!SCRIPT_RE.test(file)) continue;
          if (!graph.importersOf(file).length) continue;
          const text = ctx.fs.readText(file);
          if (!text || !/\bexport\b/.test(text) || !/\b(?:reactive|ref)\b/.test(text)) continue;
          const scope = analyzeScript(text, /\.[jt]sx$/.test(file) ? "tsx" : "ts");
          if (!scope) continue;
          const mutatorFunctions = exportedFunctions(scope.ast);
          for (const state of exportedStates(scope)) {
            const local = findLocalStateWrites(ctx, file, text, scope, state.variable, state.shape);
            const mutators = ownMutators(state, mutatorFunctions, local);
            if (!mutators.length) continue;
            const writes = new Map<string, SharedStateWrite>();
            for (const exportName of state.exportNames) {
              const found = await findSharedStateWrites(ctx, graph, {
                file,
                exportName,
                shape: state.shape,
              });
              for (const write of found) writes.set(`${write.file}:${write.range.start}`, write);
            }
            const byFile = groupByFile([...writes.values()]);
            if (byFile.size < 2) continue;
            report(ctx, file, text, state, mutators, byFile);
          }
        }
      },
    };
  },
});

function report(
  ctx: RuleContext,
  file: string,
  text: string,
  state: ExportedState,
  mutators: Mutator[],
  byFile: Map<string, SharedStateWrite[]>,
) {
  const path = (target: string) => relative(ctx.project.root, target);
  const name = state.id.name as string;
  const factory = `${state.shape}()`;
  const total = [...byFile.values()].reduce((sum, list) => sum + list.length, 0);
  const files = [...byFile].map(([target, list]) => {
    const shown = [...new Set(list.map(describeWrite))];
    const listed = shown.slice(0, MAX_LISTED_WRITES).join(", ");
    const more =
      shown.length > MAX_LISTED_WRITES ? `, and ${shown.length - MAX_LISTED_WRITES} more` : "";
    return `${path(target)} (${listed}${more})`;
  });
  const names = mutators.map((mutator) => mutator.label);
  const mutatorList =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const range = ctx.helpers.rangeFromOffsets(file, text, state.id.range[0], state.id.range[1]);
  ctx.report(
    diagnostics.VUE0048({
      why: `"${name}" is shared ${factory} state exported from ${path(file)}, which also exports ${mutatorList} to change it, yet ${byFile.size} other files write it directly (${total} ${total === 1 ? "write" : "writes"}): ${files.join("; ")}. Vue's state management guide recommends keeping the actions that mutate shared state in the module that owns it, so every change can be found and traced from one place. Writes scattered across components bypass those actions, along with any rule they enforce.`,
      fix: `Replace each direct write with a call to ${mutatorList}, or add an action to ${path(file)} for a change it does not cover yet (such as a reset) and call that. Keep the state in ${path(file)}: do not copy it into each component or move ownership into one component.`,
    }),
    {
      file,
      range,
      evidence: [
        {
          kind: "graph",
          file,
          range,
          summary: `${name} is written directly in ${byFile.size} importing files; ${path(file)} exports ${mutatorList}.`,
        },
      ],
      related: [...byFile.values()].flat().map((write) => ({
        file: write.file,
        range: write.range,
        message: `Writes ${write.target} directly${write.in === "template" ? " in the template" : ""}`,
      })),
    },
  );
}

function describeWrite(write: SharedStateWrite): string {
  const where = write.in === "template" ? " in the template" : "";
  if (write.kind === "v-model") return `v-model on ${write.target}`;
  return `${write.target}${where}`;
}

function groupByFile(writes: SharedStateWrite[]): Map<string, SharedStateWrite[]> {
  const byFile = new Map<string, SharedStateWrite[]>();
  for (const write of writes.sort((a, b) =>
    a.file === b.file ? a.range.start - b.range.start : a.file < b.file ? -1 : 1,
  )) {
    const list = byFile.get(write.file);
    if (list) list.push(write);
    else byFile.set(write.file, [write]);
  }
  return byFile;
}

/** Exported functions and state methods that write the state inside its own module. */
function ownMutators(
  state: ExportedState,
  functions: Mutator[],
  local: SharedStateWrite[],
): Mutator[] {
  const writesIn = (start: number, end: number) =>
    local.some((write) => write.range.start >= start && write.range.start < end);
  const mutators = functions.filter((fn) => writesIn(fn.start, fn.end));
  const literal = state.shape === "reactive" ? state.init.arguments?.[0] : undefined;
  if (literal?.type === "ObjectExpression") {
    for (const property of literal.properties) {
      if (property.type !== "Property" || property.value?.type !== "FunctionExpression") continue;
      const key = property.key?.type === "Identifier" ? property.key.name : null;
      const [start, end] = property.value.range;
      if (key && writesIn(start, end))
        mutators.push({ label: `${state.id.name}.${key}()`, start, end });
    }
  }
  return mutators;
}

/** Module-scope `const` bindings initialized with Vue's `reactive()` or `ref()` and exported. */
function exportedStates(scope: NonNullable<ReturnType<typeof analyzeScript>>): ExportedState[] {
  const exportNames = new Map<string, string[]>();
  const addName = (local: string, exported: string) => {
    const list = exportNames.get(local);
    if (list) list.push(exported);
    else exportNames.set(local, [exported]);
  };
  const declarations: AnyNode[] = [];
  for (const statement of scope.ast.body as AnyNode[]) {
    if (statement.type === "VariableDeclaration") declarations.push(statement);
    if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
      if (statement.declaration?.type === "VariableDeclaration") {
        declarations.push(statement.declaration);
        for (const declarator of statement.declaration.declarations)
          if (declarator.id?.type === "Identifier") addName(declarator.id.name, declarator.id.name);
      }
      if (!statement.source)
        for (const specifier of statement.specifiers ?? [])
          if (specifier.exportKind !== "type" && specifier.local?.type === "Identifier")
            addName(specifier.local.name, nameOf(specifier.exported));
    }
    if (
      statement.type === "ExportDefaultDeclaration" &&
      statement.declaration?.type === "Identifier"
    )
      addName(statement.declaration.name, "default");
  }
  const states: ExportedState[] = [];
  for (const declaration of declarations) {
    if (declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      const names = exportNames.get(declarator.id.name);
      if (!names) continue;
      const init = unwrap(declarator.init);
      if (init?.type !== "CallExpression" || init.callee?.type !== "Identifier") continue;
      const shape = factoryShape(scope, init.callee);
      if (!shape) continue;
      const [variable] = scope.scopeManager.getDeclaredVariables(declarator);
      if (variable) states.push({ variable, id: declarator.id, init, shape, exportNames: names });
    }
  }
  return states;
}

/** `reactive` or `ref` imported from Vue, or the auto-imported global of the same name. */
function factoryShape(
  scope: NonNullable<ReturnType<typeof analyzeScript>>,
  callee: AnyNode,
): Shape | undefined {
  const resolved = scope.references.get(callee)?.resolved;
  if (!resolved) return FACTORIES.get(callee.name);
  for (const definition of resolved.defs) {
    if (definition.type !== "ImportBinding") return undefined;
    const declaration = definition.parent as AnyNode;
    if (!VUE_SOURCES.has(declaration?.source?.value)) return undefined;
    const node = definition.node as AnyNode;
    if (node.type !== "ImportSpecifier") return undefined;
    return FACTORIES.get(nameOf(node.imported));
  }
  return undefined;
}

/** Exported function declarations and `const` function expressions, by exported name. */
function exportedFunctions(program: AnyNode): Mutator[] {
  const locals = new Map<string, AnyNode>();
  const exported: Array<{ local: string; name: string }> = [];
  const result: Mutator[] = [];
  const add = (name: string, node: AnyNode) =>
    result.push({ label: `${name}()`, start: node.range[0], end: node.range[1] });
  const collect = (declaration: AnyNode, isExported: boolean) => {
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      locals.set(declaration.id.name, declaration);
      if (isExported) exported.push({ local: declaration.id.name, name: declaration.id.name });
    }
    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
      for (const declarator of declaration.declarations) {
        const init = unwrap(declarator.init);
        if (declarator.id?.type !== "Identifier" || !isFunction(init)) continue;
        locals.set(declarator.id.name, init);
        if (isExported) exported.push({ local: declarator.id.name, name: declarator.id.name });
      }
    }
  };
  for (const statement of program.body as AnyNode[]) {
    if (statement.type === "ExportNamedDeclaration") {
      collect(statement.declaration, true);
      if (!statement.source)
        for (const specifier of statement.specifiers ?? [])
          if (specifier.local?.type === "Identifier")
            exported.push({ local: specifier.local.name, name: nameOf(specifier.exported) });
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      if (isFunction(declaration)) add(declaration.id?.name ?? "default", declaration);
      else if (declaration?.type === "Identifier")
        exported.push({ local: declaration.name, name: "default" });
    } else {
      collect(statement, false);
    }
  }
  for (const { local, name } of exported) {
    const node = locals.get(local);
    if (node) add(name, node);
  }
  return result;
}

function isFunction(node: AnyNode): boolean {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(
      node.type,
    )
  )
    node = node.expression;
  return node;
}

function nameOf(node: AnyNode): string {
  return node?.type === "Identifier" ? node.name : String(node?.value);
}
