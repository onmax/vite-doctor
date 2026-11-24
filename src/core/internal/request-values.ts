import type { AnyNode } from "../rule-authoring.js";
import { findFunctionVar, findStatementBinding, patternNames } from "./script-index.js";

// Request-value flow over a Doctor script AST (nodes carry `__doctorParent`): does an expression
// hold a value that only exists for one request? Rule Packs supply what counts as a source, such as
// Nuxt's `useRoute()` or h3's `getQuery(event)`; the flow follows locals, skips functions that are
// never called, and treats `import()` as the module instance every request shares.

export const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const SCOPE_TYPES = new Set([
  "BlockStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "SwitchStatement",
]);
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

export interface RequestValueSources {
  /** A node that is request data by itself, such as `useRoute()` or `getQuery(event)`. */
  isSource(node: AnyNode): boolean;
  /** The declarator binding `name` at program scope whose initializer the flow follows. */
  programBinding?(program: AnyNode, name: string): AnyNode;
  /**
   * Whether `reference`, which resolves to parameter `index` of `fn`, holds request data, such as
   * the `event` an h3 handler receives. Without it, parameters are not resolved.
   */
  parameter?(fn: AnyNode, index: number, reference: AnyNode): boolean;
  /** How many local initializers the flow follows. Defaults to 2. */
  maxDepth?: number;
}

/** Whether evaluating `value` reads a request source, directly or through local bindings. */
export function holdsRequestValue(value: AnyNode, sources: RequestValueSources): boolean {
  return flows(value, sources, 0);
}

function flows(value: AnyNode, sources: RequestValueSources, depth: number): boolean {
  let found = false;
  const visit = (node: AnyNode) => {
    if (found || !node || typeof node !== "object") return;
    if (isModuleImport(node)) {
      if (node.type !== "CallExpression") return;
      // A continuation can still perform request work even though the imported module value
      // itself is shared and safe to cache.
      for (const argument of node.arguments ?? []) {
        if (typeof argument?.type === "string") visit(argument);
      }
      return;
    }
    if (node.type === "AwaitExpression" && isModuleImport(node.argument)) {
      visit(node.argument);
      return;
    }
    if (sources.isSource(node)) {
      found = true;
      return;
    }
    if (
      node.type === "Identifier" &&
      depth < (sources.maxDepth ?? 2) &&
      localHoldsRequestValue(node, sources, depth) &&
      !isPropertyKey(node)
    ) {
      found = true;
      return;
    }
    if (FUNCTION_TYPES.has(node.type) && !isInvoked(node) && !isPromiseCallback(node)) return;
    for (const [key, child] of Object.entries(node) as [string, AnyNode][]) {
      if (key === "__doctorParent" || key === "parent" || key === "typeAnnotation") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (typeof child?.type === "string") visit(child);
    }
  };
  visit(value);
  return found;
}

function localHoldsRequestValue(node: AnyNode, sources: RequestValueSources, depth: number) {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  for (let current = parent; current; current = current.__doctorParent) {
    if (sources.parameter && FUNCTION_TYPES.has(current.type)) {
      const index = current.params.findIndex((param: AnyNode) =>
        patternNames(param).includes(node.name),
      );
      if (index >= 0) return sources.parameter(current, index, node);
    }
    const declarator =
      current.type === "Program"
        ? (sources.programBinding?.(current, node.name) ?? null)
        : SCOPE_TYPES.has(current.type)
          ? findStatementBinding(current, node.name)
          : FUNCTION_TYPES.has(current.type)
            ? findFunctionVar(current.body, node.name)
            : null;
    if (declarator?.type === "VariableDeclarator")
      return Boolean(declarator.init) && flows(declarator.init, sources, depth + 1);
    if (declarator) return false;
  }
  return false;
}

/** Whether `node` refers to the program-scope binding `name` rather than a nearer declaration. */
export function resolvesToModuleBinding(node: AnyNode, name: string) {
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (current.type === "Program") return true;
    if (FUNCTION_TYPES.has(current.type)) {
      if (current.type === "FunctionExpression" && current.id?.name === name) return false;
      if (current.params?.some((param: AnyNode) => patternNames(param).includes(name)))
        return false;
      if (findFunctionVar(current.body, name)) return false;
    } else if (SCOPE_TYPES.has(current.type)) {
      if (findStatementBinding(current, name)) return false;
    } else if (current.type === "CatchClause") {
      if (patternNames(current.param).includes(name)) return false;
    }
  }
  return false;
}

const moduleNamesByProgram = new WeakMap<object, Set<string>>();

/** Names that imports and top-level declarations bind in the program that contains `node`. */
export function moduleNames(node: AnyNode) {
  let program = node;
  while (program.__doctorParent) program = program.__doctorParent;
  let names = moduleNamesByProgram.get(program);
  if (names) return names;
  names = new Set<string>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (statement.type === "ImportDeclaration")
      for (const specifier of statement.specifiers ?? []) names.add(specifier.local.name);
    else if (declaration?.type === "FunctionDeclaration" && declaration.id)
      names.add(declaration.id.name);
    else if (declaration?.type === "VariableDeclaration")
      for (const declarator of declaration.declarations) {
        for (const name of patternNames(declarator.id)) names.add(name);
      }
  }
  moduleNamesByProgram.set(program, names);
  return names;
}

// `import()` resolves to the same module instance for every request.
export function isModuleImport(input: AnyNode): boolean {
  const node = unwrapExpression(input);
  if (node?.type === "ImportExpression") return true;
  if (node?.type !== "CallExpression") return false;
  const callee = unwrapExpression(node.callee);
  return (
    callee?.type === "MemberExpression" &&
    PROMISE_METHODS.has(callee.property?.name) &&
    isModuleImport(callee.object)
  );
}

function isPromiseCallback(node: AnyNode) {
  let parent = node.__doctorParent;
  while (parent && WRAPPERS.has(parent.type)) parent = parent.__doctorParent;
  if (parent?.type !== "CallExpression") return false;
  if (!parent.arguments?.some((argument: AnyNode) => unwrapExpression(argument) === node))
    return false;
  const callee = unwrapExpression(parent.callee);
  return (
    callee?.type === "MemberExpression" &&
    PROMISE_METHODS.has(callee.property?.name) &&
    isModuleImport(callee.object)
  );
}

export function isInvoked(node: AnyNode) {
  let parent = node.__doctorParent;
  while (parent && WRAPPERS.has(parent.type)) parent = parent.__doctorParent;
  return parent?.type === "CallExpression" && unwrapExpression(parent.callee) === node;
}

function isPropertyKey(node: AnyNode) {
  const parent = node.__doctorParent;
  return parent?.type === "Property" && parent.key === node && !parent.computed;
}

/** `a`, `a.b`, `this.a`, `f().b`, or `.b` for a callee the name cannot spell. */
export function calleeName(node: AnyNode): string | null {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression" && !node.computed) {
    const object =
      node.object?.type === "ThisExpression" ? "this" : calleeName(unwrapExpression(node.object));
    if (node.object?.type === "CallExpression")
      return `${calleeName(unwrapExpression(node.object.callee)) ?? ""}().${node.property?.name}`;
    return object ? `${object}.${node.property?.name}` : `.${node.property?.name}`;
  }
  return null;
}

export function unwrapExpression(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}
