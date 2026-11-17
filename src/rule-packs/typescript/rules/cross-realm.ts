import { parentOf, type AnyNode } from "./shared.js";
import { createLocalEvidence, expression } from "./local-evidence.js";

export type LocalEvidence = ReturnType<typeof createLocalEvidence>;
export type Origin = "unknown parameter" | "callback result" | "loaded module";

// How to recognize a value of each built-in class without relying on this realm's constructor.
// A guard is a helper the developer writes; a replacement is a built-in check that already works.
type RealmSafeCheck = { guard: string; check: string } | { replacement: string };

const brand = (name: string) =>
  `that returns Object.prototype.toString.call(value) === '[object ${name}]'`;
const view = (name: string) =>
  `that returns ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object ${name}]'`;
const errorName = (name: string) => `that checks isError(value) and value.name === '${name}'`;

const TYPED_ARRAYS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
];
const ERROR_SUBCLASSES = [
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
];

export const REALM_CLASSES: Record<string, RealmSafeCheck> = {
  Response: {
    guard: "isResponseLike",
    check: "that checks the members you use, such as status, headers and body",
  },
  Request: {
    guard: "isRequestLike",
    check: "that checks the members you use, such as url, method and headers",
  },
  Headers: { guard: "isHeadersLike", check: "that checks the get() and forEach() methods" },
  Blob: {
    guard: "isBlobLike",
    check: "that checks the members you use, such as arrayBuffer(), size and type",
  },
  File: { guard: "isFileLike", check: "that checks arrayBuffer(), size and name" },
  FormData: { guard: "isFormData", check: brand("FormData") },
  URL: { guard: "isURL", check: brand("URL") },
  URLSearchParams: { guard: "isURLSearchParams", check: brand("URLSearchParams") },
  ReadableStream: { guard: "isReadableStreamLike", check: "that checks the getReader() method" },
  Date: { guard: "isDate", check: brand("Date") },
  ArrayBuffer: { guard: "isArrayBuffer", check: brand("ArrayBuffer") },
  SharedArrayBuffer: { guard: "isSharedArrayBuffer", check: brand("SharedArrayBuffer") },
  ...Object.fromEntries(
    TYPED_ARRAYS.map((name) => [name, { guard: `is${name}`, check: view(name) }]),
  ),
  Map: { guard: "isMap", check: brand("Map") },
  Set: { guard: "isSet", check: brand("Set") },
  WeakMap: { guard: "isWeakMap", check: brand("WeakMap") },
  WeakSet: { guard: "isWeakSet", check: brand("WeakSet") },
  RegExp: { guard: "isRegExp", check: brand("RegExp") },
  Promise: { guard: "isPromiseLike", check: "that checks typeof value.then === 'function'" },
  Error: {
    guard: "isError",
    check:
      "that returns Error.isError(value) where the runtime has it, or Object.prototype.toString.call(value) === '[object Error]'",
  },
  ...Object.fromEntries(
    ERROR_SUBCLASSES.map((name) => [name, { guard: `is${name}`, check: errorName(name) }]),
  ),
  DOMException: {
    guard: "isDOMException",
    check: brand("DOMException"),
  },
  Array: { replacement: "Array.isArray(value), which is true for arrays from any realm" },
  Function: {
    replacement: "typeof value === 'function', which is true for functions from any realm",
  },
  Object: { replacement: "Object(value) === value, which is true for objects from any realm" },
};

// Realm-safe checks that also accept the class, such as isAsyncIterable() for streams in server
// runtimes or ArrayBuffer.isView() for typed arrays.
const GUARD_ALIASES: Record<string, string[]> = {
  ReadableStream: ["AsyncIterable"],
  Promise: ["Thenable"],
  Object: ["Record"],
  ...Object.fromEntries(TYPED_ARRAYS.map((name) => [name, ["View"]])),
  ...Object.fromEntries(ERROR_SUBCLASSES.map((name) => [name, ["Error"]])),
};

/** The fix sentence after "Replace <what> with". */
export function realmSafeFix(className: string): string {
  const check = REALM_CLASSES[className]!;
  return "replacement" in check
    ? `${check.replacement}.`
    : `a guard helper, ${check.guard}(value): value is ${className}, ${check.check}.`;
}

export function crossRealmOrigin(
  evidence: LocalEvidence,
  node: AnyNode,
  depth = 0,
): Origin | undefined {
  const value = expression(node, true);
  const direct = valueOrigin(evidence, value);
  if (direct) return direct;
  if (value?.type !== "Identifier") {
    const root = memberRoot(awaited(value));
    return root && root !== value && moduleOrigin(evidence, root) ? "loaded module" : undefined;
  }
  const binding = evidence.binding(value);
  if (!binding || binding.written) return undefined;
  if (binding.kind === "parameter")
    return isUnknownOrAny(binding.annotation) ? "unknown parameter" : undefined;
  if (binding.kind !== "const" || binding.node.start >= value.start) return undefined;
  const init = binding.init ?? destructuredInit(binding.node);
  if (!init) return undefined;
  if (binding.init) {
    const origin = valueOrigin(evidence, expression(init, true));
    if (origin) return origin;
    // `const alias = value` keeps the origin of the value it copies.
    if (expression(init, true)?.type === "Identifier" && depth < 4)
      return crossRealmOrigin(evidence, init, depth + 1);
  }
  // The module namespace itself is never a web value; only its exports are.
  if (binding.init && awaited(init)?.type !== "MemberExpression") return undefined;
  const root = memberRoot(init);
  return root && moduleOrigin(evidence, root) ? "loaded module" : undefined;
}

// A guard on the same value next to the check already accepts other realms:
// `value instanceof Response || isResponseLike(value)`, `isBlobLike(body) && !(body instanceof Blob)`,
// or `if (isResponseLike(value))` in the statement before or after the check.
export function hasRealmSafeAlternative(
  node: AnyNode,
  className: string,
  subject: string,
): boolean {
  const isGuard = (candidate: AnyNode) =>
    isGuardCall(candidate, className, subject) || isBrandCheck(candidate, className, subject);
  let chain = node;
  while (
    ["LogicalExpression", "ParenthesizedExpression"].includes(parentOf(chain)?.type) ||
    (parentOf(chain)?.type === "UnaryExpression" && parentOf(chain).operator === "!")
  )
    chain = parentOf(chain);
  const foreignResult = (candidate: AnyNode, guard = true): boolean | undefined => {
    const value = expression(candidate, true);
    if (value === node) return ["!==", "!="].includes(node.operator);
    if (isGuard(value))
      return value.type === "BinaryExpression" && ["!==", "!="].includes(value.operator)
        ? !guard
        : guard;
    // A foreign built-in object survives the usual null/type rejection before a brand fallback.
    if (value?.type === "BinaryExpression" && ["===", "==", "!==", "!="].includes(value.operator)) {
      for (const [left, right] of [
        [value.left, value.right],
        [value.right, value.left],
      ]) {
        const operand = expression(left, true);
        const literal = expression(right, true);
        if (literal?.type !== "Literal") continue;
        const equality =
          operand?.type === "Identifier" && operand.name === subject && literal.value === null
            ? false
            : operand?.type === "UnaryExpression" &&
                operand.operator === "typeof" &&
                operand.argument?.name === subject &&
                literal.value === "object" &&
                className !== "Function"
              ? true
              : undefined;
        if (equality !== undefined)
          return ["!==", "!="].includes(value.operator) ? !equality : equality;
      }
    }
    if (value?.type === "UnaryExpression" && value.operator === "!") {
      const result = foreignResult(value.argument, guard);
      return result === undefined ? undefined : !result;
    }
    if (value?.type !== "LogicalExpression") return undefined;
    const left = foreignResult(value.left, guard);
    const right = foreignResult(value.right, guard);
    if (value.operator === "||")
      return left === true || right === true
        ? true
        : left === false && right === false
          ? false
          : undefined;
    if (value.operator === "&&")
      return left === false || right === false
        ? false
        : left === true && right === true
          ? true
          : undefined;
    return undefined;
  };
  for (let alternative = node; alternative; alternative = parentOf(alternative)) {
    if (
      containsCall(alternative, isGuard) &&
      (foreignResult(alternative) === true ||
        (["!==", "!="].includes(node.operator) && foreignResult(alternative) === false)) &&
      foreignResult(alternative, false) !== undefined &&
      foreignResult(alternative) !== foreignResult(alternative, false)
    )
      return true;
    if (alternative === chain) break;
  }
  const statement = enclosingStatement(chain);
  const siblings = statementList(statement);
  if (!siblings) return false;
  const index = siblings.indexOf(statement);
  const handlesGuard = (sibling: AnyNode) => {
    if (
      sibling?.type !== "IfStatement" ||
      !isGuard(expression(sibling.test, true)) ||
      foreignResult(sibling.test) !== true
    )
      return false;
    const branch = sibling.consequent;
    const last = branch?.type === "BlockStatement" ? branch.body.at(-1) : branch;
    if (last?.type !== "ReturnStatement") return false;
    if (!isBrandCheck(expression(sibling.test, true), className, subject)) return true;
    const result = expression(last.argument, true);
    return (
      (result?.type === "Literal" && result.value === true) ||
      (result?.type === "Identifier" && result.name === subject)
    );
  };
  if (handlesGuard(siblings[index - 1])) return true;
  if (statement?.type !== "IfStatement" || foreignResult(statement.test) !== false) return false;
  if (handlesGuard(siblings[index + 1])) return true;
  for (const sibling of siblings.slice(index + 1)) {
    if (sibling.type === "IfStatement" && foreignResult(sibling.test) === false) continue;
    return (
      sibling.type === "ReturnStatement" &&
      containsCall(sibling.argument, isGuard) &&
      foreignResult(sibling.argument) === true &&
      foreignResult(sibling.argument, false) === false
    );
  }
  return false;
}

// A guard helper may keep instanceof as a fast path before it compares the brand of the same value:
// `Object.prototype.toString.call(value) === "[object Response]"`.
function isBrandCheck(node: AnyNode, className: string, subject: string): boolean {
  if (node?.type !== "BinaryExpression" || !["===", "!==", "==", "!="].includes(node.operator))
    return false;
  const tags = [className, ...(className.endsWith("Error") ? ["Error"] : [])];
  return [
    [node.left, node.right],
    [node.right, node.left],
  ].some(([call, tag]) => {
    const literal = expression(tag, true);
    return (
      literal?.type === "Literal" &&
      tags.some((name) => literal.value === `[object ${name}]`) &&
      isBrandCall(expression(call, true), subject)
    );
  });
}

function isBrandCall(node: AnyNode, subject: string): boolean {
  if (node?.type !== "CallExpression") return false;
  const callee = expression(node.callee, true);
  if (callee?.type !== "MemberExpression" || callee.computed || callee.property?.name !== "call")
    return false;
  const method = expression(callee.object, true);
  if (method?.type !== "MemberExpression" || method.computed) return false;
  if (method.property?.name !== "toString") return false;
  const argument = expression(node.arguments?.[0], true);
  return argument?.type === "Identifier" && argument.name === subject;
}

// `isUint8Array(value)` and `types.isUint8Array(value)` from node:util both count.
function isGuardCall(node: AnyNode, className: string, subject: string): boolean {
  if (node?.type !== "CallExpression") return false;
  const callee = expression(node.callee, true);
  const name =
    callee?.type === "Identifier"
      ? callee.name
      : callee?.type === "MemberExpression" && !callee.computed
        ? callee.property?.name
        : undefined;
  return (
    typeof name === "string" &&
    guardPattern(className).test(name) &&
    (node.arguments ?? []).some((argument: AnyNode) => {
      const value = expression(argument, true);
      return value?.type === "Identifier" && value.name === subject;
    })
  );
}

function enclosingStatement(node: AnyNode): AnyNode {
  let current = node;
  while (parentOf(current) && !statementList(current)) current = parentOf(current);
  return current;
}

function statementList(statement: AnyNode): AnyNode[] | undefined {
  const parent = parentOf(statement);
  if (parent?.type === "BlockStatement" || parent?.type === "Program") return parent.body;
  if (parent?.type === "SwitchCase") return parent.consequent;
  return undefined;
}

// Guards inside nested functions run at another time, so they do not count.
function containsCall(node: AnyNode, matches: (call: AnyNode) => boolean): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((child) => containsCall(child, matches));
  if (typeof node.type !== "string") return false;
  if (matches(node)) return true;
  if (/Function/.test(node.type)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent" || !value || typeof value !== "object")
      continue;
    if (containsCall(value, matches)) return true;
  }
  return false;
}

function guardPattern(className: string) {
  const names = [className, ...(GUARD_ALIASES[className] ?? [])].join("|");
  return new RegExp(`^is(?!Not[A-Z])(?:[A-Z]\\w*)?(?:${names})(?:Like)?$`);
}

// `const { handler } = await import(id)` binds `handler` without an initializer of its own.
function destructuredInit(identifier: AnyNode): AnyNode {
  let current = identifier;
  let parent = parentOf(current);
  while (parent?.type === "Property" || parent?.type === "ObjectPattern") {
    current = parent;
    parent = parentOf(current);
  }
  return current.type === "ObjectPattern" &&
    parent?.type === "VariableDeclarator" &&
    parent.id === current
    ? parent.init
    : undefined;
}

function valueOrigin(evidence: LocalEvidence, node: AnyNode): Origin | undefined {
  const call = awaited(node);
  if (call?.type !== "CallExpression") return undefined;
  const callee = expression(call.callee, true);
  if (callee?.type === "Identifier") {
    const binding = evidence.binding(callee);
    return binding?.kind === "parameter" && !binding.written ? "callback result" : undefined;
  }
  if (callee?.type !== "MemberExpression") return undefined;
  const root = memberRoot(callee);
  const binding = root?.type === "Identifier" ? evidence.binding(root) : null;
  return binding?.kind === "parameter" && !binding.written && !isRealmClassTyped(binding.annotation)
    ? "callback result"
    : undefined;
}

function moduleOrigin(evidence: LocalEvidence, node: AnyNode): boolean {
  const value = expression(node, true);
  if (isModuleLoad(awaited(value))) return true;
  if (value?.type !== "Identifier") return false;
  const binding = evidence.binding(value);
  return Boolean(
    binding &&
    !binding.written &&
    binding.kind === "const" &&
    isModuleLoad(awaited(expression(binding.init, true))),
  );
}

function isModuleLoad(node: AnyNode): boolean {
  if (node?.type === "ImportExpression") return true;
  if (node?.type !== "CallExpression") return false;
  const callee = expression(node.callee, true);
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  if (callee.property?.name === "ssrLoadModule") return true;
  // Vite's ModuleRunner loads modules with runner.import(); other import() methods are unrelated.
  if (callee.property?.name !== "import") return false;
  const receiver = expression(callee.object, true);
  const receiverName =
    receiver?.type === "Identifier"
      ? receiver.name
      : receiver?.type === "MemberExpression" && !receiver.computed
        ? receiver.property?.name
        : undefined;
  return typeof receiverName === "string" && /runner$/i.test(receiverName);
}

function awaited(node: AnyNode): AnyNode {
  let current = expression(node, true);
  while (current?.type === "AwaitExpression") current = expression(current.argument, true);
  return current;
}

function memberRoot(node: AnyNode): AnyNode {
  let current = awaited(node);
  while (current?.type === "MemberExpression") current = awaited(current.object);
  return current;
}

function isUnknownOrAny(annotation: AnyNode): boolean {
  if (annotation?.type === "TSUnionType") return annotation.types?.some(isUnknownOrAny) ?? false;
  if (annotation?.type === "TSParenthesizedType") return isUnknownOrAny(annotation.typeAnnotation);
  return annotation?.type === "TSUnknownKeyword" || annotation?.type === "TSAnyKeyword";
}

// Methods on a typed built-in value (`request.clone()`, `date.getTime()`, `map.get(key)`) return
// values from the value's own realm, not from a caller-supplied callback.
function isRealmClassTyped(annotation: AnyNode): boolean {
  if (annotation?.type === "TSParenthesizedType")
    return isRealmClassTyped(annotation.typeAnnotation);
  if (annotation?.type === "TSUnionType") {
    const types = (annotation.types ?? []).filter(
      (type: AnyNode) => type.type !== "TSUndefinedKeyword" && type.type !== "TSNullKeyword",
    );
    return types.length > 0 && types.every(isRealmClassTyped);
  }
  return (
    annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier" &&
    Object.hasOwn(REALM_CLASSES, annotation.typeName.name)
  );
}
