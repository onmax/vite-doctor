import { staticValue } from "./_errors-helpers.js";
import {
  type AnyNode,
  createRule,
  h3ExportName,
  h3Major,
  isH3Call,
  isH3HandlerFile,
  report,
} from "./shared.js";

const ruleId = "h3/errors/no-numeric-create-error";

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
    prefilter: { names: ["createError", "HTTPError"] },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    const check = (node: AnyNode, callee: string) => {
      const status = staticValue(ctx, node.arguments?.[0]);
      if (typeof status !== "number") return;
      const major = h3Major(ctx);
      const fix =
        major === 1
          ? `Use createError({ statusCode: ${status} }).`
          : callee === "HTTPError"
            ? `Use HTTPError.status(${status}) or new HTTPError({ status: ${status} }).`
            : major === undefined
              ? `Use createError({ status: ${status} }) on H3 v2, or createError({ statusCode: ${status} }) on H3 v1.`
              : `Use createError({ status: ${status} }) or HTTPError.status(${status}).`;
      const call = callee === "HTTPError" ? `new HTTPError(${status})` : `createError(${status})`;
      report(
        ctx,
        node,
        ruleId,
        "error",
        "errors",
        `${call} reads ${status} as neither a status object nor a message, so the error responds with 500 instead of ${status}.`,
        fix,
      );
    };
    return {
      CallExpression(node: AnyNode) {
        if (isH3Call(ctx, node, ["createError"])) check(node, "createError");
      },
      NewExpression(node: AnyNode) {
        if (h3ExportName(ctx, node.callee) === "HTTPError") check(node, "HTTPError");
      },
    };
  },
});
