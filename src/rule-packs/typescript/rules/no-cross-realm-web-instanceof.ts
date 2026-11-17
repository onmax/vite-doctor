import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, parentOf, report, type AnyNode } from "./shared.js";
import { createLocalEvidence, expression } from "./local-evidence.js";

const ruleId = "typescript/boundaries/no-cross-realm-web-instanceof";

// Error is left out: cross-realm errors are real, but `err instanceof Error` usually guards a
// message read with a String(err) fallback, so reporting it would mostly be noise.
const WEB_CLASSES = new Set([
  "Response",
  "Request",
  "Headers",
  "Date",
  "Blob",
  "File",
  "FormData",
  "ArrayBuffer",
  "URL",
  "URLSearchParams",
  "ReadableStream",
]);

// Structural guards that also accept the class from any realm, such as isAsyncIterable() for
// streams in server runtimes.
const GUARD_ALIASES: Record<string, string[]> = { ReadableStream: ["AsyncIterable"] };

const BRAND = (name: string) =>
  `that returns Object.prototype.toString.call(value) === '[object ${name}]'`;

// Each guard name matches guardPattern(), so a check written with the helper is accepted.
const GUARDS: Record<string, { name: string; check: string }> = {
  Date: { name: "isDate", check: BRAND("Date") },
  ArrayBuffer: { name: "isArrayBuffer", check: BRAND("ArrayBuffer") },
  Response: {
    name: "isResponseLike",
    check: "that checks the members you use, such as status, headers and body",
  },
  Request: {
    name: "isRequestLike",
    check: "that checks the members you use, such as url, method and headers",
  },
  Headers: { name: "isHeadersLike", check: "that checks the get() and forEach() methods" },
  Blob: {
    name: "isBlobLike",
    check: "that checks the members you use, such as arrayBuffer(), size and type",
  },
  File: { name: "isFileLike", check: "that checks arrayBuffer(), size and name" },
  FormData: { name: "isFormData", check: BRAND("FormData") },
  URL: { name: "isURL", check: BRAND("URL") },
  URLSearchParams: { name: "isURLSearchParams", check: BRAND("URLSearchParams") },
  ReadableStream: { name: "isReadableStreamLike", check: "that checks the getReader() method" },
};

type Origin = "unknown parameter" | "callback result" | "loaded module";

export const noCrossRealmWebInstanceof = createRule({
  meta: {
    id: ruleId,
    title: "Do not use instanceof for web values from another realm",
    description:
      "Report instanceof checks against web platform classes on values that may come from another JavaScript realm.",
    why: "Every realm has its own Response, Request, Date, Blob and URL constructors. Values created by the Vite module runner, workerd or miniflare, Vitest environments, or a second copy of undici fail instanceof against this realm's class, so the check takes the wrong branch. This rule only reports values that crossed a boundary in this file: parameters typed unknown or any, results of calling a parameter, and module namespaces from import() or ssrLoadModule().",
    recommendedReplacement:
      "Move the check into a guard helper such as isResponseLike(value) that checks the brand with Object.prototype.toString.call(value) or the members you use, and call it instead of instanceof.",
    examples: [
      {
        title: "Brand-check values from host callbacks",
        language: "ts",
        invalid:
          "export function toResponse(value: unknown): Response {\n  if (value instanceof Response) return value\n  return Response.json(value)\n}",
        valid:
          "function isResponse(value: unknown): value is Response {\n  return Object.prototype.toString.call(value) === '[object Response]'\n}\n\nexport function toResponse(value: unknown): Response {\n  if (isResponse(value)) return value\n  return Response.json(value)\n}",
      },
    ],
    category: "boundaries",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "structural-review",
    docsUrl:
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/instanceof#instanceof_and_multiple_realms",
    requires: { script: true },
    prefilter: { names: ["instanceof"] },
  },
  create(ctx) {
    if (!isTypeScriptSource(ctx)) return;
    let evidence: ReturnType<typeof createLocalEvidence>;
    return {
      Program(node: AnyNode) {
        evidence = createLocalEvidence(node);
      },
      BinaryExpression(node: AnyNode) {
        if (node.operator !== "instanceof" || node.right?.type !== "Identifier") return;
        const name = node.right.name;
        if (!WEB_CLASSES.has(name) || evidence.binding(node.right)) return;
        if (hasDuckTypedAlternative(node, name)) return;
        const origin = crossRealmOrigin(evidence, node.left);
        if (!origin) return;
        report(
          ctx,
          node,
          ruleId,
          `This ${origin} can hold a ${name} created in another realm (Vite module runner, workerd, Vitest environment, or a duplicated undici), where instanceof ${name} is false.`,
          `Replace instanceof ${name} with a guard helper, ${GUARDS[name]!.name}(value): value is ${name}, ${GUARDS[name]!.check}.`,
        );
      },
    };
  },
});

// A guard on the same value next to the check already accepts other realms:
// `value instanceof Response || isResponseLike(value)`, `isBlobLike(body) && !(body instanceof Blob)`,
// or `if (isResponseLike(value))` in the statement before or after the check.
function hasDuckTypedAlternative(node: AnyNode, className: string): boolean {
  const subject = expression(node.left, true);
  if (subject?.type !== "Identifier") return false;
  const isGuard = (candidate: AnyNode) => isGuardCall(candidate, className, subject.name);
  let chain = node;
  while (
    ["LogicalExpression", "ParenthesizedExpression"].includes(parentOf(chain)?.type) ||
    (parentOf(chain)?.type === "UnaryExpression" && parentOf(chain).operator === "!")
  )
    chain = parentOf(chain);
  const foreignResult = (candidate: AnyNode, guard = true): boolean | undefined => {
    const value = expression(candidate, true);
    if (value === node) return false;
    if (isGuard(value)) return guard;
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
  if (
    containsCall(chain, isGuard) &&
    foreignResult(chain) === true &&
    foreignResult(chain, false) !== true
  )
    return true;
  const statement = enclosingStatement(chain);
  const siblings = statementList(statement);
  if (!siblings) return false;
  const index = siblings.indexOf(statement);
  const handlesGuard = (sibling: AnyNode) => {
    if (sibling?.type !== "IfStatement" || !isGuard(expression(sibling.test, true))) return false;
    const branch = sibling.consequent;
    const last = branch?.type === "BlockStatement" ? branch.body.at(-1) : branch;
    return last?.type === "ReturnStatement";
  };
  if (handlesGuard(siblings[index - 1])) return true;
  return (
    statement?.type === "IfStatement" &&
    foreignResult(statement.test) === false &&
    handlesGuard(siblings[index + 1])
  );
}

function isGuardCall(node: AnyNode, className: string, subject: string): boolean {
  if (node?.type !== "CallExpression") return false;
  const callee = expression(node.callee, true);
  return (
    callee?.type === "Identifier" &&
    guardPattern(className).test(callee.name) &&
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

function crossRealmOrigin(
  evidence: ReturnType<typeof createLocalEvidence>,
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

function valueOrigin(
  evidence: ReturnType<typeof createLocalEvidence>,
  node: AnyNode,
): Origin | undefined {
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
  return binding?.kind === "parameter" && !binding.written && !isWebTyped(binding.annotation)
    ? "callback result"
    : undefined;
}

function moduleOrigin(evidence: ReturnType<typeof createLocalEvidence>, node: AnyNode): boolean {
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

// Methods on a typed web value (`request.clone()`, `date.getTime()`) return values from the
// value's own realm, not from a caller-supplied callback.
function isWebTyped(annotation: AnyNode): boolean {
  if (annotation?.type === "TSParenthesizedType") return isWebTyped(annotation.typeAnnotation);
  if (annotation?.type === "TSUnionType") {
    const types = (annotation.types ?? []).filter(
      (type: AnyNode) => type.type !== "TSUndefinedKeyword" && type.type !== "TSNullKeyword",
    );
    return types.length > 0 && types.every(isWebTyped);
  }
  return (
    annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier" &&
    WEB_CLASSES.has(annotation.typeName.name)
  );
}
