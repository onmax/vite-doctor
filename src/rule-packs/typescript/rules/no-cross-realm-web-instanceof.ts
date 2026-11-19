import { createRule } from "../../../core/index.js";
import { isTypeScriptSource } from "./shared.js";
import { WEB_PLATFORM_CLASSES, crossRealmInstanceofVisitor } from "./cross-realm.js";

const ruleId = "typescript/boundaries/no-cross-realm-web-instanceof";

export const noCrossRealmWebInstanceof = createRule({
  meta: {
    id: ruleId,
    title: "Do not use instanceof for web platform values from another realm",
    description:
      "Report instanceof checks against web platform and binary data classes, such as Response, Request, Blob, URL, ArrayBuffer and Uint8Array, on values that may come from another JavaScript realm or another copy of the class.",
    why: "Response, Request, Headers, Blob, URL, ArrayBuffer, Uint8Array and the other web platform classes have one constructor per realm, and often more than one per process: a second copy of undici such as Miniflare's, the Blob and URL of a Vitest DOM environment, a node:vm context or an iframe. A value built by any of them fails instanceof against this realm's class, so the check takes the wrong branch. This rule only reports values that crossed a boundary in this file: parameters typed unknown or any, results of calling a parameter, and module namespaces from import() or ssrLoadModule(). A parameter of a function that the file neither exports nor passes around is skipped when every call passes a value proven local, such as a literal or an object constructed with an unshadowed built-in. Catching an error does not establish its origin. JavaScript built-ins such as Error and Date are reported by typescript/boundaries/no-cross-realm-builtin-instanceof.",
    recommendedReplacement:
      "Use a realm-safe intrinsic or a tag shared by the implementations you support where applicable. A member check only narrows to the capabilities it verifies, not the full class. If you need full class semantics, validate or normalize the value at the integration boundary.",
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
    return crossRealmInstanceofVisitor(
      ctx,
      ruleId,
      WEB_PLATFORM_CLASSES,
      "by another copy of the class (a second undici such as Miniflare's, a Vitest DOM environment, node:vm, or an iframe)",
    );
  },
});
