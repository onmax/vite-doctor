import type { AnyNode } from "../rule-authoring.js";
import {
  findFunctionVar,
  findStatementBinding,
  patternNames,
  scriptNodesOfType,
} from "./script-index.js";

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
const UNKNOWN_VALUE = Symbol("unknown value");
type StaticValue = string | number | boolean | bigint | null | typeof UNKNOWN_VALUE;

export interface RequestValueSources {
  /** A node that is request data by itself, such as `useRoute()` or `getQuery(event)`. */
  isSource(node: AnyNode): boolean;
  /** The declarator binding `name` at program scope whose initializer the flow follows. */
  programBinding?: (program: AnyNode, name: string, reference: AnyNode) => AnyNode;
  /**
   * Whether `reference`, which resolves to parameter `index` of `fn`, holds request data, such as
   * the `event` an h3 handler receives. Without it, parameters are not resolved.
   */
  parameter?(fn: AnyNode, index: number, reference: AnyNode): boolean;
  /** How many local initializers the flow follows. Defaults to 2. */
  maxDepth?: number;
  /** Trace the selected value, not evaluation of other fields in a local object initializer. */
  projectObjectMembers?: boolean;
  /** Whether an operation is proven not to execute in the runtime being traced. */
  isSkippedOperation?(node: AnyNode): boolean;
}

/** Whether evaluating `value` reads a request source, directly or through local bindings. */
export function holdsRequestValue(value: AnyNode, sources: RequestValueSources): boolean {
  return flows(value, sources, 0);
}

/** The imported export, null for a rejected binding, or undefined for an unbound identifier. */
export function requestImportName(
  callee: AnyNode,
  acceptsSource: (source: string) => boolean,
): string | null | undefined {
  const namespace = callee?.type === "MemberExpression";
  const binding = namespace ? unwrapExpression(callee.object) : callee;
  if (binding?.type !== "Identifier" || !resolvesToModuleBinding(binding, binding.name))
    return null;
  let program = binding;
  while (program.__doctorParent) program = program.__doctorParent;
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.name !== binding.name) continue;
      if (statement.importKind === "type" || specifier.importKind === "type") return null;
      if (!acceptsSource(String(statement.source.value))) return null;
      if (namespace && specifier.type === "ImportNamespaceSpecifier")
        return staticMemberName(callee) ?? null;
      if (!namespace && specifier.type === "ImportSpecifier")
        return String(specifier.imported?.name ?? specifier.imported?.value);
      return null;
    }
  }
  return namespace || moduleNames(binding).has(binding.name) ? null : undefined;
}

export function staticMemberName(node: AnyNode): string | undefined {
  if (node?.type !== "MemberExpression") return undefined;
  if (!node.computed) return node.property?.name;
  return staticRequestString(node.property);
}

export function staticRequestString(node: AnyNode): string | undefined {
  node = unwrapExpression(node);
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
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
    if (sources.projectObjectMembers && node.type === "MemberExpression") {
      const selected = projectMember(node, sources, (sources.maxDepth ?? 2) - depth);
      if (selected) {
        found = flows(selected.value, sources, depth + selected.steps);
        return;
      }
    }
    if (node.type === "LogicalExpression") {
      visit(node.left);
      if (!found && !logicalRightIsSkipped(node, sources.programBinding)) visit(node.right);
      return;
    }
    for (const [key, child] of Object.entries(node) as [string, AnyNode][]) {
      if (key === "__doctorParent" || key === "parent" || key === "typeAnnotation") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (typeof child?.type === "string") visit(child);
    }
  };
  visit(value);
  return found;
}

function projectMember(
  node: AnyNode,
  sources: RequestValueSources,
  remaining: number,
): { value: AnyNode; steps: number } | undefined {
  const name = staticMemberName(node);
  if (name === undefined || name === "__proto__" || remaining <= 0) return;
  let object = unwrapExpression(node.object);
  let steps = 1;
  while (object?.type !== "ObjectExpression" && steps < remaining) {
    if (object?.type === "Identifier") {
      object = unwrapExpression(provenConstBinding(object, sources.programBinding)?.init);
      steps++;
    } else if (object?.type === "MemberExpression") {
      const inner = projectMember(object, sources, remaining - steps);
      if (!inner || !inner.value) return inner;
      object = unwrapExpression(inner.value);
      steps += inner.steps;
    } else return;
  }
  if (object?.type !== "ObjectExpression") return;
  const write = setupMemberWrite(node, object, name, sources);
  if (write === UNKNOWN_VALUE) return { value: null, steps };
  for (const property of object.properties.toReversed()) {
    if (property.type !== "Property") return;
    const key =
      !property.computed && property.key.type === "Identifier"
        ? property.key.name
        : staticRequestString(property.key);
    if (key === undefined || key === "__proto__") return;
    if (key === name)
      return property.kind === "init" ? { value: write ?? property.value, steps } : undefined;
  }
  return { value: write, steps };
}

function setupMemberWrite(
  reference: AnyNode,
  object: AnyNode,
  name: string,
  sources: RequestValueSources,
): AnyNode {
  let program = reference;
  while (program.__doctorParent) {
    if (FUNCTION_TYPES.has(program.type)) return null;
    program = program.__doctorParent;
  }
  const isObject = (expression: AnyNode) => {
    let base = unwrapExpression(expression);
    while (base?.type === "Identifier")
      base = unwrapExpression(provenConstBinding(base, sources.programBinding)?.init);
    return base === object;
  };
  const affectsMember = (input: AnyNode): boolean => {
    const target = unwrapExpression(input);
    if (target?.type === "MemberExpression") {
      if (!isObject(target.object)) return affectsMember(target.object);
      const key = staticMemberName(target);
      return key === undefined || key === name || key === "__proto__";
    }
    if (target?.type === "ArrayPattern") return target.elements.some(affectsMember);
    if (target?.type === "ObjectPattern")
      return target.properties.some((property: AnyNode) =>
        affectsMember(property.value ?? property.argument),
      );
    if (target?.type === "AssignmentPattern") return affectsMember(target.left);
    if (target?.type === "RestElement") return affectsMember(target.argument);
    return false;
  };

  let latest: AnyNode = null;
  let value: AnyNode = null;
  for (const operation of scriptNodesOfType(
    program,
    "AssignmentExpression",
    "UpdateExpression",
    "UnaryExpression",
    "ForInStatement",
    "ForOfStatement",
    "CallExpression",
    "NewExpression",
  )) {
    if (operation.end > reference.start || operation.end <= (latest?.end ?? object.end)) continue;
    if (operation.type === "CallExpression" || operation.type === "NewExpression") {
      const callee = unwrapExpression(operation.callee);
      if (
        !operation.arguments.some((argument: AnyNode) => isObject(argument)) &&
        !(callee?.type === "MemberExpression" && isObject(callee.object))
      )
        continue;
    } else {
      if (operation.type === "UnaryExpression" && operation.operator !== "delete") continue;
      if (!affectsMember(operation.left ?? operation.argument)) continue;
    }
    if (sources.isSkippedOperation?.(operation)) continue;

    latest = operation;
    const statement = enclosingExpression(operation).__doctorParent;
    const target = unwrapExpression(operation.left);
    value =
      operation.type === "AssignmentExpression" &&
      operation.operator === "=" &&
      statement?.type === "ExpressionStatement" &&
      statement.__doctorParent === program &&
      staticMemberName(target) === name &&
      isObject(target.object)
        ? operation.right
        : UNKNOWN_VALUE;
  }
  return value;
}

function enclosingExpression(node: AnyNode): AnyNode {
  while (WRAPPERS.has(node.__doctorParent?.type)) node = node.__doctorParent;
  return node;
}

function localHoldsRequestValue(node: AnyNode, sources: RequestValueSources, depth: number) {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  let child = node;
  for (let current = parent; current; current = current.__doctorParent) {
    if (sources.parameter && FUNCTION_TYPES.has(current.type)) {
      const index = current.params.findIndex((param: AnyNode) =>
        patternNames(param).includes(node.name),
      );
      if (index >= 0) return sources.parameter(current, index, node);
    }
    const declarator =
      current.type === "Program"
        ? (sources.programBinding?.(current, node.name, node) ?? null)
        : nearerBinding(current, child, node.name);
    if (declarator?.type === "VariableDeclarator")
      return Boolean(declarator.init) && flows(declarator.init, sources, depth + 1);
    if (declarator) return false;
    child = current;
  }
  return false;
}

/** Whether `node` refers to the program-scope binding `name` rather than a nearer declaration. */
export function resolvesToModuleBinding(node: AnyNode, name: string) {
  let child = node;
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (current.type === "Program") return true;
    if (nearerBinding(current, child, name)) return false;
    child = current;
  }
  return false;
}

export function resolveLexicalBinding(node: AnyNode): AnyNode {
  return resolveBinding(node, (program, name) => findStatementBinding(program, name));
}

function resolveBinding(
  node: AnyNode,
  programBinding: NonNullable<RequestValueSources["programBinding"]>,
): AnyNode {
  let child = node;
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (current.type === "Program") return programBinding(current, node.name, node);
    const binding = nearerBinding(current, child, node.name);
    if (binding) return binding;
    child = current;
  }
  return null;
}

export function logicalRightIsSkipped(
  node: AnyNode,
  programBinding?: RequestValueSources["programBinding"],
): boolean {
  return shortCircuits(node.operator, staticValue(node.left, programBinding, 0));
}

function shortCircuits(operator: string, left: StaticValue): boolean {
  if (left === UNKNOWN_VALUE) return false;
  if (operator === "&&") return !left;
  if (operator === "||") return Boolean(left);
  return operator === "??" && left !== null;
}

function staticValue(
  input: AnyNode,
  programBinding: RequestValueSources["programBinding"],
  depth: number,
): StaticValue {
  const node = unwrapExpression(input);
  if (!node || depth > 5) return UNKNOWN_VALUE;
  if (node.type === "Literal" && !node.regex) return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length)
    return node.quasis[0].value.cooked;
  if (node.type === "LogicalExpression") {
    const left = staticValue(node.left, programBinding, depth + 1);
    if (left === UNKNOWN_VALUE || shortCircuits(node.operator, left)) return left;
    return staticValue(node.right, programBinding, depth + 1);
  }
  const binding = provenConstBinding(node, programBinding);
  if (binding) return staticValue(binding.init, programBinding, depth + 1);
  return UNKNOWN_VALUE;
}

export function provenConstBinding(
  node: AnyNode,
  programBinding?: RequestValueSources["programBinding"],
): AnyNode {
  if (node.type !== "Identifier") return null;
  const binding = programBinding
    ? resolveBinding(node, programBinding)
    : resolveLexicalBinding(node);
  return binding?.type === "VariableDeclarator" &&
    binding.id.type === "Identifier" &&
    binding.__doctorParent?.kind === "const" &&
    binding.end <= node.start
    ? binding
    : null;
}

function nearerBinding(scope: AnyNode, child: AnyNode, name: string): AnyNode {
  if (FUNCTION_TYPES.has(scope.type)) {
    if (scope.type === "FunctionExpression" && scope.id?.name === name) return scope;
    return (
      scope.params?.find((param: AnyNode) => patternNames(param).includes(name)) ??
      findFunctionVar(scope.body, name)
    );
  }
  if (scope.type === "ClassExpression" && scope.id?.name === name) return scope;
  if (scope.type === "SwitchStatement" && child === scope.discriminant) return null;
  if (scope.type === "StaticBlock" || scope.type === "TSModuleBlock")
    return findStatementBinding(scope, name) ?? findFunctionVar(scope.body, name);
  if (SCOPE_TYPES.has(scope.type)) return findStatementBinding(scope, name);
  if (scope.type === "CatchClause" && patternNames(scope.param).includes(name)) return scope.param;
  return null;
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
