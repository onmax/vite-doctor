import { walkScriptLocal, type AnyNode } from "../../../../core/rule-authoring.js";

// Execution analysis resolves the same bindings and writes for every candidate node, so each root
// is indexed once and reused. This relies on script ASTs staying immutable after parsing.

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const ALL = Symbol("all");
const typedNodes = new WeakMap<object, Map<string | symbol, AnyNode[]>>();

/** Nodes under `root` with one of `types`, in the same order `walkScriptLocal` visits them. */
export function scriptNodesOfType(root: AnyNode, ...types: string[]): AnyNode[] {
  if (!root || typeof root !== "object") return [];
  let index = typedNodes.get(root);
  if (!index) {
    const all: AnyNode[] = [];
    walkScriptLocal(root, (node) => all.push(node));
    index = new Map([[ALL, all]]);
    typedNodes.set(root, index);
  }
  const key = types.join(",");
  let nodes = index.get(key);
  if (!nodes) {
    const wanted = new Set(types);
    nodes = index.get(ALL)!.filter((node) => wanted.has(node.type));
    index.set(key, nodes);
  }
  return nodes;
}

/** Every name `patternBinds(pattern, name)` accepts. */
export function patternNames(node: AnyNode, names: string[] = []): string[] {
  if (!node) return names;
  if (node.type === "Identifier") names.push(node.name);
  else if (node.type === "AssignmentPattern") patternNames(node.left, names);
  else if (node.type === "RestElement") patternNames(node.argument, names);
  else if (node.type === "ArrayPattern")
    for (const item of node.elements) patternNames(item, names);
  else if (node.type === "ObjectPattern")
    for (const item of node.properties) patternNames(item.value ?? item.argument, names);
  return names;
}

const functionVars = new WeakMap<object, Map<string, AnyNode>>();

/** First `var` declarator binding `name` inside a function body, without entering nested functions. */
export function findFunctionVar(node: AnyNode, name: string): AnyNode {
  if (!node || typeof node !== "object") return null;
  let vars = functionVars.get(node);
  if (!vars) {
    vars = new Map();
    collectFunctionVars(node, vars);
    functionVars.set(node, vars);
  }
  return vars.get(name) ?? null;
}

function collectFunctionVars(node: AnyNode, vars: Map<string, AnyNode>) {
  if (!node || typeof node !== "object") return;
  if (FUNCTION_TYPES.has(node.type)) return;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const item of node.declarations)
      for (const name of patternNames(item.id)) if (!vars.has(name)) vars.set(name, item);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    collectFunctionVars(value, vars);
  }
}

const STATEMENT_SCOPE_TYPES = new Set([
  "Program",
  "BlockStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "SwitchStatement",
]);
const statementBindings = new WeakMap<object, Map<string, AnyNode>>();

/** First declaration binding `name` among the statements a scope node owns directly. */
export function findStatementBinding(scope: AnyNode, name: string): AnyNode {
  if (!STATEMENT_SCOPE_TYPES.has(scope.type)) return null;
  let bindings = statementBindings.get(scope);
  if (!bindings) {
    bindings = new Map();
    for (const statement of scopeStatements(scope)) {
      const declaration = statement.declaration ?? statement;
      const declared: [string, AnyNode][] = [];
      if (["FunctionDeclaration", "ClassDeclaration"].includes(declaration.type)) {
        if (declaration.id?.name !== undefined) declared.push([declaration.id.name, declaration]);
      } else if (declaration.type === "VariableDeclaration") {
        for (const item of declaration.declarations)
          for (const name of patternNames(item.id)) declared.push([name, item]);
      } else if (declaration.type === "ImportDeclaration") {
        for (const item of declaration.specifiers)
          if (item.local?.name !== undefined) declared.push([item.local.name, item]);
      }
      for (const [name, binding] of declared) if (!bindings.has(name)) bindings.set(name, binding);
    }
    statementBindings.set(scope, bindings);
  }
  return bindings.get(name) ?? null;
}

function scopeStatements(scope: AnyNode): AnyNode[] {
  if (scope.type === "Program" || scope.type === "BlockStatement") return scope.body;
  if (scope.type === "ForStatement") return [scope.init].filter(Boolean);
  if (scope.type === "ForOfStatement" || scope.type === "ForInStatement") return [scope.left];
  return scope.cases.flatMap((item: AnyNode) => item.consequent);
}

type MemoLevel = Map<unknown, unknown>;

/**
 * Memoizes a pure analysis over one parent map. Keys compare by identity, so callers must pass the
 * same objects for equivalent inputs; fresh synthetic objects only miss the cache.
 */
export function memoizeAnalysis<T>(
  store: WeakMap<object, MemoLevel>,
  parents: object,
  keys: unknown[],
  compute: () => T,
): T {
  let level = store.get(parents);
  if (!level) {
    level = new Map();
    store.set(parents, level);
  }
  for (const key of keys.slice(0, -1)) {
    let next = level.get(key) as MemoLevel | undefined;
    if (!next) {
      next = new Map();
      level.set(key, next);
    }
    level = next;
  }
  const last = keys.at(-1);
  if (level.has(last)) return level.get(last) as T;
  const value = compute();
  level.set(last, value);
  return value;
}
