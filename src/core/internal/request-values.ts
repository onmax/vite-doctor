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
const PROJECTION_LIMIT = Symbol("projection work limit");
const PROJECTION_WORK_BUDGET = 50_000;
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
  /** Report that an intervening operation leaves a possible, but unproven, request dependency. */
  onUncertainProjection?(): void;
  /** Whether an operation is proven not to execute in the runtime being traced. */
  isSkippedOperation?(node: AnyNode): boolean;
}

type FlowSources = RequestValueSources & {
  spendProjectionWork?: () => void;
  tracingProjection?: boolean;
  initializerResults?: WeakMap<object, Map<number, boolean>>;
};

/** Whether evaluating `value` reads a request source, directly or through local bindings. */
export function holdsRequestValue(value: AnyNode, sources: RequestValueSources): boolean {
  if (!sources.projectObjectMembers) return flows(value, sources, 0);
  let remaining = PROJECTION_WORK_BUDGET;
  return flows(
    value,
    {
      ...sources,
      initializerResults: new WeakMap(),
      spendProjectionWork: () => {
        if (remaining <= 0) throw PROJECTION_LIMIT;
        remaining--;
      },
    },
    0,
  );
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

function flows(value: AnyNode, sources: FlowSources, depth: number): boolean {
  let found = false;
  const visit = (node: AnyNode) => {
    if (found || !node || typeof node !== "object") return;
    if (sources.tracingProjection) sources.spendProjectionWork?.();
    if (sources.isSkippedOperation?.(node)) return;
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
      const projected = projectedRequestValue(node, sources, depth);
      if (projected !== undefined) {
        found = projected;
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

function projectedRequestValue(node: AnyNode, sources: FlowSources, depth: number) {
  try {
    const selected = projectMember(node, sources, (sources.maxDepth ?? 2) - depth);
    if (!selected) return;
    const candidateSources = sources.tracingProjection
      ? sources
      : { ...sources, tracingProjection: true };
    const dependsOnSource = (candidates: Map<AnyNode, number>) => {
      for (const [candidate, steps] of candidates)
        if (flows(candidate, candidateSources, depth + steps)) return true;
      return false;
    };
    if (!selected.uncertain) return dependsOnSource(selected.values);
    if (dependsOnSource(selected.controls) || dependsOnSource(selected.values))
      sources.onUncertainProjection?.();
    return false;
  } catch (error) {
    if (error !== PROJECTION_LIMIT || sources.tracingProjection) throw error;
    sources.onUncertainProjection?.();
    return false;
  }
}

interface MemberProjection {
  values: Map<AnyNode, number>;
  controls: Map<AnyNode, number>;
  uncertain: boolean;
}

function projectMember(
  node: AnyNode,
  sources: FlowSources,
  remaining: number,
): MemberProjection | undefined {
  const name = staticMemberName(node);
  if (name === undefined || name === "__proto__" || remaining <= 0) return;
  const select = (expression: AnyNode, steps: number): MemberProjection | undefined => {
    const object = unwrapExpression(expression);
    if (object?.type === "ObjectExpression") {
      sources.spendProjectionWork?.();
      const { value, possibleWrites, controls } = setupMemberWrites(node, object, name, sources);
      const initial = objectMemberInitializer(object, name);
      if (initial === UNKNOWN_VALUE && !possibleWrites.size) return;
      const values = new Map<AnyNode, number>();
      const previous = value ?? (initial === UNKNOWN_VALUE ? object : initial);
      if (previous) values.set(previous, steps);
      for (const write of possibleWrites) {
        const candidate =
          write.type === "CallExpression" || write.type === "NewExpression" ? write : write.right;
        if (candidate) values.set(candidate, steps);
      }
      return {
        values,
        controls: new Map([...controls].map((control) => [control, steps])),
        uncertain: possibleWrites.size > 0,
      };
    }
    if (steps >= remaining) return;
    if (object?.type === "Identifier") {
      const binding = constIdentifierBinding(object, sources.programBinding);
      if (binding && binding.end <= object.start) return select(binding.init, steps + 1);
    } else if (object?.type === "MemberExpression") {
      const inner = projectMember(object, sources, remaining - steps);
      if (!inner) return;
      const values = new Map<AnyNode, number>();
      const controls = new Map<AnyNode, number>();
      for (const [control, innerSteps] of inner.controls) controls.set(control, steps + innerSteps);
      let uncertain = inner.uncertain;
      for (const [value, innerSteps] of inner.values) {
        const totalSteps = steps + innerSteps;
        const projected = select(value, totalSteps);
        uncertain ||= projected?.uncertain ?? false;
        const candidates = projected?.values ?? new Map([[value, totalSteps]]);
        for (const [candidate, candidateSteps] of candidates)
          values.set(candidate, Math.min(values.get(candidate) ?? Infinity, candidateSteps));
        for (const [control, controlSteps] of projected?.controls ?? [])
          controls.set(control, Math.min(controls.get(control) ?? Infinity, controlSteps));
      }
      return { values, controls, uncertain };
    }
  };
  return select(node.object, 1);
}

function objectMemberInitializer(object: AnyNode, name: string): AnyNode {
  for (const property of object.properties.toReversed()) {
    if (property.type !== "Property") return UNKNOWN_VALUE;
    const key =
      !property.computed && property.key.type === "Identifier"
        ? property.key.name
        : staticRequestString(property.key);
    if (key === undefined || key === "__proto__") return UNKNOWN_VALUE;
    if (key === name) return property.kind === "init" ? property.value : UNKNOWN_VALUE;
  }
  return null;
}

function setupMemberWrites(
  reference: AnyNode,
  object: AnyNode,
  name: string,
  sources: FlowSources,
): { value: AnyNode; possibleWrites: Set<AnyNode>; controls: Set<AnyNode> } {
  const possibleWrites = new Set<AnyNode>();
  const controls = new Set<AnyNode>();
  let program = reference;
  while (program.__doctorParent) {
    if (FUNCTION_TYPES.has(program.type)) return { value: null, possibleWrites, controls };
    program = program.__doctorParent;
  }
  const isObject = (expression: AnyNode) => {
    let base = unwrapExpression(expression);
    const seen = new Set<AnyNode>();
    while (base?.type === "Identifier") {
      sources.spendProjectionWork?.();
      const binding = constIdentifierBinding(base, sources.programBinding);
      if (!binding || seen.has(binding)) return false;
      seen.add(binding);
      base = unwrapExpression(binding.init);
    }
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

  const isCall = (node: AnyNode) => node.type === "CallExpression" || node.type === "NewExpression";
  const mayWrite = (operation: AnyNode) => {
    if (isCall(operation)) {
      const callee = unwrapExpression(operation.callee);
      return (
        operation.arguments.some(isObject) ||
        (callee?.type === "MemberExpression" && isObject(callee.object))
      );
    }
    if (operation.type === "UnaryExpression" && operation.operator !== "delete") return false;
    return affectsMember(operation.left ?? operation.argument);
  };
  const addWrite = (operation: AnyNode) => {
    possibleWrites.add(operation);
    addWriteGuards(operation, controls);
    if (!isCall(operation)) addComputedKeys(operation.left ?? operation.argument, controls);
  };

  const setupOperations: AnyNode[] = [];
  const functionOperations = new Map<AnyNode, AnyNode[]>();
  const firstSuspension = new Map<AnyNode, AnyNode>();
  let lastSetupSuspension = -Infinity;
  for (const operation of scriptNodesOfType(
    program,
    "AssignmentExpression",
    "UpdateExpression",
    "UnaryExpression",
    "ForInStatement",
    "ForOfStatement",
    "CallExpression",
    "NewExpression",
    "AwaitExpression",
  )) {
    sources.spendProjectionWork?.();
    const scope = enclosingWriteScope(operation);
    if (sources.isSkippedOperation?.(operation) || skipsStaticBranch(operation, scope, sources))
      continue;
    const operand =
      operation.type === "AwaitExpression"
        ? operation.argument
        : operation.type === "ForOfStatement" && operation.await
          ? operation.right
          : null;
    if (operand) {
      if (scope === program && operand.end <= reference.start)
        lastSetupSuspension = Math.max(lastSetupSuspension, operand.end);
      else if (
        scope?.async &&
        operand.end < (firstSuspension.get(scope)?.end ?? Infinity) &&
        straightLineAwait(operation, scope)
      )
        firstSuspension.set(scope, operand);
    }
    if (operation.type === "AwaitExpression") continue;
    if (scope === program) {
      if (operation.end <= reference.start && operation.end > object.end)
        setupOperations.push(operation);
    } else if (scope) {
      let operations = functionOperations.get(scope);
      if (!operations) functionOperations.set(scope, (operations = []));
      operations.push(operation);
    }
  }

  const collectCallWrites = (call: AnyNode, afterYield: boolean) => {
    const pending: { invocation: AnyNode; resolvedFunction?: AnyNode }[] = [{ invocation: call }];
    const visited = new Set<AnyNode>();
    const forwardedCalls = new Map<AnyNode, Set<AnyNode>>();
    const callSites = new Map<AnyNode, Set<AnyNode>>();
    const writingFunctions = new Set<AnyNode>();
    while (pending.length > 0) {
      sources.spendProjectionWork?.();
      const next = pending.pop();
      if (!next) break;
      const { invocation, resolvedFunction } = next;
      const callee = unwrapExpression(invocation.callee);
      if (afterYield && !resolvedFunction && PROMISE_METHODS.has(staticMemberName(callee) ?? "")) {
        for (const argument of invocation.arguments) {
          const callback = localFunction(argument, sources.programBinding);
          if (callback) pending.push({ invocation, resolvedFunction: callback });
        }
      }
      const fn = resolvedFunction ?? localFunction(invocation.callee, sources.programBinding);
      if (!fn || fn.generator) continue;
      let sites = callSites.get(fn);
      if (!sites) callSites.set(fn, (sites = new Set()));
      sites.add(invocation);
      const forwarded = directParameterCall(fn);
      if (
        forwarded &&
        !invocation.arguments.some((argument: AnyNode) => argument.type === "SpreadElement")
      ) {
        const callback = localFunction(
          invocation.arguments[forwarded.index],
          sources.programBinding,
        );
        if (callback && functionOperations.get(fn)?.includes(forwarded.call)) {
          let callbacks = forwardedCalls.get(forwarded.call);
          if (!callbacks) forwardedCalls.set(forwarded.call, (callbacks = new Set()));
          if (!callbacks.has(callback)) {
            callbacks.add(callback);
            pending.push({
              invocation: forwarded.call,
              resolvedFunction: callback,
            });
          }
        }
      }
      if (visited.has(fn)) continue;
      visited.add(fn);
      const boundary = afterYield ? undefined : firstSuspension.get(fn);
      for (const operation of functionOperations.get(fn) ?? []) {
        sources.spendProjectionWork?.();
        if (
          boundary &&
          (operation.end > boundary.end ||
            (operation.end === boundary.end && operation.start < boundary.start))
        )
          continue;
        if (mayWrite(operation)) {
          addWrite(operation);
          writingFunctions.add(fn);
        }
        if (isCall(operation)) pending.push({ invocation: operation });
      }
    }
    for (const fn of writingFunctions) {
      for (const invocation of callSites.get(fn) ?? []) {
        sources.spendProjectionWork?.();
        addWriteGuards(invocation, controls);
        const caller = enclosingWriteScope(invocation);
        if (caller && caller !== program) writingFunctions.add(caller);
      }
    }
  };

  let value: AnyNode = null;
  let lastDefiniteWrite = object.end;
  for (const operation of setupOperations.sort((a, b) => a.end - b.end || b.start - a.start)) {
    if (!mayWrite(operation)) {
      if (isCall(operation)) collectCallWrites(operation, false);
      continue;
    }

    const statement = enclosingExpression(operation).__doctorParent;
    const target = unwrapExpression(operation.left);
    if (
      operation.type === "AssignmentExpression" &&
      operation.operator === "=" &&
      statement?.type === "ExpressionStatement" &&
      statement.__doctorParent === program &&
      staticMemberName(target) === name &&
      isObject(target.object)
    ) {
      value = operation.right;
      lastDefiniteWrite = operation.end;
      possibleWrites.clear();
      controls.clear();
    } else {
      addWrite(operation);
      if (isCall(operation)) collectCallWrites(operation, false);
    }
  }
  if (lastSetupSuspension >= lastDefiniteWrite)
    for (const operation of setupOperations)
      if (isCall(operation) && operation.end <= lastSetupSuspension)
        collectCallWrites(operation, true);
  return { value, possibleWrites, controls };
}

function enclosingWriteScope(operation: AnyNode): AnyNode {
  let scope = operation.__doctorParent;
  while (scope && scope.type !== "Program" && !FUNCTION_TYPES.has(scope.type))
    scope = scope.__doctorParent;
  return scope;
}

function addWriteGuards(operation: AnyNode, controls: Set<AnyNode>) {
  for (
    let child = operation, parent = child.__doctorParent;
    parent && !FUNCTION_TYPES.has(parent.type);
    child = parent, parent = parent.__doctorParent
  ) {
    if (
      ((parent.type === "IfStatement" || parent.type === "ConditionalExpression") &&
        child !== parent.test) ||
      ((parent.type === "WhileStatement" ||
        parent.type === "DoWhileStatement" ||
        parent.type === "ForStatement") &&
        child === parent.body &&
        parent.test)
    )
      controls.add(parent.test);
    else if (parent.type === "LogicalExpression" && child === parent.right)
      controls.add(parent.left);
    else if (parent.type === "SwitchStatement" && child !== parent.discriminant)
      controls.add(parent.discriminant);
    else if (parent.type === "SwitchCase" && parent.test && child !== parent.test)
      controls.add(parent.test);
  }
}

function addComputedKeys(input: AnyNode, controls: Set<AnyNode>) {
  let member = unwrapExpression(input);
  while (member?.type === "MemberExpression") {
    if (member.computed && staticMemberName(member) === undefined) controls.add(member.property);
    member = unwrapExpression(member.object);
  }
}

function straightLineAwait(operation: AnyNode, fn: AnyNode): boolean {
  if (operation.type !== "AwaitExpression") return false;
  let expression = enclosingExpression(operation);
  const parent = expression.__doctorParent;
  if (
    parent?.type === "AssignmentExpression" &&
    parent.operator === "=" &&
    parent.right === expression
  )
    expression = enclosingExpression(parent);
  const statement = expression.__doctorParent;
  return statement?.type === "ExpressionStatement" && statement.__doctorParent === fn.body;
}

function skipsStaticBranch(node: AnyNode, scope: AnyNode, sources: RequestValueSources): boolean {
  let child = node;
  for (
    let parent = child.__doctorParent;
    parent && parent !== scope;
    parent = child.__doctorParent
  ) {
    if (parent.type === "ConditionalExpression" || parent.type === "IfStatement") {
      const condition = staticValue(parent.test, sources.programBinding, 0);
      if (
        condition !== UNKNOWN_VALUE &&
        child === (condition ? parent.alternate : parent.consequent)
      )
        return true;
    }
    if (
      parent.type === "LogicalExpression" &&
      child === parent.right &&
      logicalRightIsSkipped(parent, sources.programBinding)
    )
      return true;
    child = parent;
  }
  return false;
}

function directParameterCall(fn: AnyNode): { call: AnyNode; index: number } | undefined {
  let body = fn.body;
  if (body?.type === "BlockStatement") {
    if (body.body.length !== 1) return;
    const statement = body.body[0];
    if (statement.type !== "ExpressionStatement" && statement.type !== "ReturnStatement") return;
    body = statement.expression ?? statement.argument;
  }
  let call = unwrapExpression(body);
  if (call?.type === "AwaitExpression") call = unwrapExpression(call.argument);
  if (call?.type !== "CallExpression") return;
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "Identifier") return;
  const index = fn.params.findIndex(
    (parameter: AnyNode) => parameter.type === "Identifier" && parameter.name === callee.name,
  );
  if (index >= 0) return { call, index };
}

function localFunction(
  expression: AnyNode,
  programBinding: RequestValueSources["programBinding"],
): AnyNode {
  let node = unwrapExpression(expression);
  const seen = new Set<AnyNode>();
  while (node?.type === "Identifier") {
    const binding = programBinding
      ? resolveBinding(node, programBinding)
      : resolveLexicalBinding(node);
    if (!binding || seen.has(binding)) return null;
    if (binding.type === "FunctionDeclaration" || binding.type === "FunctionExpression")
      return binding;
    if (
      binding.type !== "VariableDeclarator" ||
      binding.id.type !== "Identifier" ||
      binding.__doctorParent?.kind !== "const"
    )
      return null;
    seen.add(binding);
    node = unwrapExpression(binding.init);
  }
  return FUNCTION_TYPES.has(node?.type) ? node : null;
}

function enclosingExpression(node: AnyNode): AnyNode {
  while (WRAPPERS.has(node.__doctorParent?.type)) node = node.__doctorParent;
  return node;
}

function localHoldsRequestValue(node: AnyNode, sources: FlowSources, depth: number) {
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
      return declarator.init ? traceInitializer(declarator.init, sources, depth + 1) : false;
    if (declarator) return false;
    child = current;
  }
  return false;
}

function traceInitializer(init: AnyNode, sources: FlowSources, depth: number): boolean {
  const memo = sources.tracingProjection ? undefined : sources.initializerResults;
  if (!memo) return flows(init, sources, depth);
  let results = memo.get(init);
  if (!results) memo.set(init, (results = new Map()));
  const previous = results.get(depth);
  if (previous !== undefined) return previous;
  const result = flows(init, sources, depth);
  results.set(depth, result);
  return result;
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
  const binding = constIdentifierBinding(node, programBinding);
  if (binding && binding.end <= node.start)
    return staticValue(binding.init, programBinding, depth + 1);
  return UNKNOWN_VALUE;
}

function constIdentifierBinding(
  node: AnyNode,
  programBinding?: RequestValueSources["programBinding"],
): AnyNode {
  if (node.type !== "Identifier") return null;
  const binding = programBinding
    ? resolveBinding(node, programBinding)
    : resolveLexicalBinding(node);
  return binding?.type === "VariableDeclarator" &&
    binding.id.type === "Identifier" &&
    binding.__doctorParent?.kind === "const"
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
