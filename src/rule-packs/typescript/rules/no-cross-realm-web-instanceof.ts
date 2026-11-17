import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, parentOf, report, type AnyNode } from "./shared.js";
import { createLocalEvidence, expression } from "./local-evidence.js";
import {
  REALM_CLASSES,
  crossRealmOrigin,
  hasRealmSafeAlternative,
  realmSafeFix,
  type LocalEvidence,
} from "./cross-realm.js";

const ruleId = "typescript/boundaries/no-cross-realm-web-instanceof";

export const noCrossRealmWebInstanceof = createRule({
  meta: {
    id: ruleId,
    title: "Do not use instanceof for built-in values from another realm",
    description:
      "Report instanceof checks against web platform and JavaScript built-in classes on values that may come from another JavaScript realm.",
    why: "Every realm has its own Response, Request, Blob, URL, Date, Uint8Array, ArrayBuffer, Map, Set, Error and Array constructors. Values created by the Vite module runner, workerd or miniflare, Vitest environments, or a second copy of undici fail instanceof against this realm's class, so the check takes the wrong branch. This rule only reports values that crossed a boundary in this file: parameters typed unknown or any, results of calling a parameter, and module namespaces from import() or ssrLoadModule().",
    recommendedReplacement:
      "Move the check into a guard helper such as isResponseLike(value) or isUint8Array(value) that checks the brand with Object.prototype.toString.call(value) or the members you use, and call it instead of instanceof. Use Array.isArray(value) for arrays.",
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
    let evidence: LocalEvidence;
    return {
      Program(node: AnyNode) {
        evidence = createLocalEvidence(node);
      },
      BinaryExpression(node: AnyNode) {
        if (node.operator !== "instanceof" || node.right?.type !== "Identifier") return;
        const name = node.right.name;
        if (!Object.hasOwn(REALM_CLASSES, name) || evidence.binding(node.right)) return;
        const subject = expression(node.left, true);
        if (subject?.type === "Identifier" && hasRealmSafeAlternative(node, name, subject.name))
          return;
        if (/Error$|^DOMException$/.test(name) && hasStringFallback(node, subject)) return;
        const origin = crossRealmOrigin(evidence, node.left);
        if (!origin) return;
        report(
          ctx,
          node,
          ruleId,
          `This ${origin} can hold ${/^[AEIO]/.test(name) ? "an" : "a"} ${name} created in another realm (Vite module runner, workerd, Vitest environment, or a duplicated undici), where instanceof ${name} is false.`,
          `Replace instanceof ${name} with ${realmSafeFix(name)}`,
        );
      },
    };
  },
});

// `error instanceof Error ? error.message : String(error)` still reports the message of an error
// from another realm, only with an "Error: " prefix, so the check costs nothing worth reporting.
function hasStringFallback(node: AnyNode, subject: AnyNode): boolean {
  let test = node;
  while (parentOf(test)?.type === "ParenthesizedExpression") test = parentOf(test);
  const conditional = parentOf(test);
  if (conditional?.type !== "ConditionalExpression" || conditional.test !== test) return false;
  const message = expression(conditional.consequent, true);
  const fallback = expression(conditional.alternate, true);
  const argument = expression(fallback?.arguments?.[0], true);
  return (
    message?.type === "MemberExpression" &&
    !message.computed &&
    message.property?.name === "message" &&
    message.object?.type === "Identifier" &&
    message.object.name === subject?.name &&
    fallback?.type === "CallExpression" &&
    expression(fallback.callee, true)?.type === "Identifier" &&
    expression(fallback.callee, true).name === "String" &&
    subject?.type === "Identifier" &&
    argument?.type === "Identifier" &&
    argument.name === subject.name
  );
}
