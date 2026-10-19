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

const REPLACEMENTS: Record<string, string> = {
  Date: "Object.prototype.toString.call(value) === '[object Date]'",
  ArrayBuffer: "Object.prototype.toString.call(value) === '[object ArrayBuffer]'",
  Response:
    "a brand check such as Object.prototype.toString.call(value) === '[object Response]' plus typeof value.status === 'number'",
  Request:
    "a brand check such as Object.prototype.toString.call(value) === '[object Request]' plus typeof value.url === 'string'",
  Headers: "typeof value?.get === 'function' && typeof value?.forEach === 'function'",
  Blob: "typeof value?.arrayBuffer === 'function' && typeof value?.size === 'number'",
  File: "typeof value?.arrayBuffer === 'function' && typeof value?.name === 'string'",
  FormData: "Object.prototype.toString.call(value) === '[object FormData]'",
  URL: "Object.prototype.toString.call(value) === '[object URL]'",
  URLSearchParams: "Object.prototype.toString.call(value) === '[object URLSearchParams]'",
  ReadableStream: "typeof value?.getReader === 'function'",
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
      "Check the brand with Object.prototype.toString.call(value) or duck-type the members you use, for example typeof value?.arrayBuffer === 'function'.",
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
          `Replace instanceof ${name} with ${REPLACEMENTS[name]}.`,
        );
      },
    };
  },
});

// `value instanceof Response || isResponseLike(value)` already accepts other realms.
function hasDuckTypedAlternative(node: AnyNode, className: string): boolean {
  const subject = expression(node.left, true);
  if (subject?.type !== "Identifier") return false;
  let chain = node;
  while (parentOf(chain)?.type === "LogicalExpression" && parentOf(chain).operator === "||")
    chain = parentOf(chain);
  const operands: AnyNode[] = [];
  const collect = (current: AnyNode) => {
    current = expression(current, true);
    if (current?.type === "LogicalExpression" && current.operator === "||") {
      collect(current.left);
      collect(current.right);
    } else operands.push(current);
  };
  collect(chain);
  return operands.some((operand) => {
    if (operand?.type !== "CallExpression") return false;
    const callee = expression(operand.callee, true);
    return (
      callee?.type === "Identifier" &&
      guardPattern(className).test(callee.name) &&
      operand.arguments?.some(
        (argument: AnyNode) =>
          expression(argument, true)?.type === "Identifier" &&
          expression(argument, true).name === subject.name,
      )
    );
  });
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
