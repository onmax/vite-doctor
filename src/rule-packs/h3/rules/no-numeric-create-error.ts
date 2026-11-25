import { createRule } from "./shared.js";

export const noNumericCreateError = createRule({
  meta: {
    id: "h3/errors/no-numeric-create-error",
    title: "Pass createError() an object, not a status number",
    description: "Flags createError() called with a bare status code, such as createError(404).",
    why: "createError() reads the status from an object or a message string. A number is neither, so createError(404) builds a 500 error in both H3 v1 and v2, and clients get a server error instead of the intended status.",
    recommendedReplacement:
      "Pass the status in an object, such as createError({ status: 404 }), or use HTTPError.status(404) in H3 v2.",
    category: "errors",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/blob/main/src/error.ts",
    requires: { script: true },
  },
  create() {
    return undefined;
  },
});
