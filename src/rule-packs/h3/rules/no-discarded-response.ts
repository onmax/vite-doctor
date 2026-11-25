import {
  type AnyNode,
  createRule,
  h3ExportName,
  isDiscardedExpression,
  isH3Call,
  isH3HandlerFile,
  isHandlerFunction,
  nearestFunctionOrProgram,
  report,
  sourceForNode,
} from "./shared.js";

// In h3 2.0.8 these return a response and write nothing to the event. serveStatic() is left out
// because it sets response headers on the event itself.
const builders = [
  "redirect",
  "redirectBack",
  "noContent",
  "iterable",
  "html",
  "proxy",
  "proxyRequest",
  "sendRedirect",
  "sendNoContent",
  "sendStream",
  "sendWebResponse",
  "sendProxy",
  "sendIterable",
  "handleCors",
];

export const noDiscardedResponse = createRule({
  meta: {
    id: "h3/response/no-discarded-response",
    title: "Return the response an H3 v2 helper builds",
    description:
      "Flags H3 v2 response helpers such as redirect(), html(), and noContent() whose result is never returned from the handler.",
    why: "In H3 v2 these helpers only build a response value. A call whose result is dropped sends nothing, so the handler falls through and responds with whatever it returns next.",
    recommendedReplacement:
      'Return the helper\'s result from the handler, such as return redirect("/login").',
    category: "response",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/utils/response",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    return {
      CallExpression(node: AnyNode) {
        if (!isH3Call(ctx, node, builders) || !isDiscardedExpression(node)) return;
        if (!isHandlerFunction(ctx, nearestFunctionOrProgram(node))) return;
        const name = h3ExportName(ctx, node.callee);
        const call = sourceForNode(node, ctx.file.text);
        report(
          ctx,
          node,
          "h3/response/no-discarded-response",
          "error",
          "response",
          name === "handleCors"
            ? "handleCors() returns the preflight response instead of sending it, so an OPTIONS preflight falls through to the rest of the handler."
            : `${name}() builds a response value and sends nothing, so the handler falls through and responds with whatever it returns next.`,
          name === "handleCors"
            ? `Return the preflight response: const cors = ${call}; if (cors !== false) return cors.`
            : `Return it from the handler: return ${call}.`,
        );
      },
    };
  },
});
