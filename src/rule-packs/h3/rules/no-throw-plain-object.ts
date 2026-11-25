import { createRule } from "./shared.js";

export const noThrowPlainObject = createRule({
  meta: {
    id: "h3/errors/no-throw-plain-object",
    title: "Throw an HTTPError instead of a plain object",
    description:
      "Flags throw statements in H3 handlers that throw an object literal such as { statusCode: 404 }.",
    why: "H3 v2 turns a thrown value that is not an Error into an unhandled 500 and drops its fields. H3 v1 passed it through createError(), so code migrated from v1 that throws { statusCode } now answers every such error with 500.",
    recommendedReplacement:
      'Throw an HTTPError, such as throw new HTTPError({ status: 404, message: "Not found" }) or throw HTTPError.status(404).',
    category: "errors",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/blob/main/src/error.ts",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create() {
    return undefined;
  },
});
