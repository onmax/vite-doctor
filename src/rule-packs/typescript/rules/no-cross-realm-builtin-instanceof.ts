import { createRule } from "../../../core/index.js";
import { isTypeScriptSource } from "./shared.js";
import { BUILTIN_CLASSES, crossRealmInstanceofVisitor } from "./cross-realm.js";

const ruleId = "typescript/boundaries/no-cross-realm-builtin-instanceof";

export const noCrossRealmBuiltinInstanceof = createRule({
  meta: {
    id: ruleId,
    title: "Do not use instanceof for JavaScript built-ins from another realm",
    description:
      "Report instanceof checks against JavaScript built-ins, such as Error, Date, Map, RegExp, Promise, Array and Object, on values that may come from another JavaScript realm.",
    why: "Error, Date, Map, Set, RegExp, Promise, Array, Function and Object have one constructor per realm. A value created in a node:vm context, an iframe, or a Vitest vmThreads or vmForks pool fails instanceof against this realm's class, so the check takes the wrong branch. Values from the Vite module runner, a duplicated package, a worker or structuredClone() are built with this realm's built-ins, so most of these checks never see a foreign value, and the rule reports them at low confidence. It only reports values that crossed a boundary in this file: parameters typed unknown or any, results of calling a parameter, and module namespaces from import() or ssrLoadModule(). A parameter of a function that the file neither exports nor passes around is skipped when every call passes a literal, a new object or a caught error.",
    recommendedReplacement:
      "Use the realm-safe check: Array.isArray(value) for arrays, typeof value === 'function' for functions, Error.isError(value) or an Object.prototype.toString.call(value) brand check in a guard helper such as isError(value) or isDate(value) for the rest.",
    examples: [
      {
        title: "Brand-check errors from a sandbox",
        language: "ts",
        invalid:
          "export function toSandboxError(error: unknown): Error {\n  if (error instanceof Error) return error\n  return new Error(String(error))\n}",
        valid:
          "function isError(value: unknown): value is Error {\n  return Object.prototype.toString.call(value) === '[object Error]'\n}\n\nexport function toSandboxError(error: unknown): Error {\n  if (isError(error)) return error\n  return new Error(String(error))\n}",
      },
    ],
    category: "boundaries",
    severity: "warn",
    confidence: "heuristic-low",
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
      BUILTIN_CLASSES,
      "in another realm (node:vm, an iframe, or a Vitest vm pool)",
    );
  },
});
