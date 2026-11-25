import {
  canUseNativeH3,
  type AnyNode,
  createRule,
  h3ExportName,
  isH3Call,
  isH3HandlerFile,
  isHandlerEvent,
  report,
  sourceForNode,
} from "./shared.js";

// The v1 forms of these took the event first; the v2 forms in h3 2.0.8 do not.
const eventlessHelpers = ["redirect", "noContent", "html", "iterable", "sendWebResponse"];

export const noEventFirstArg = createRule({
  meta: {
    id: "h3/response/no-event-first-arg",
    title: "Drop the event argument from H3 v2 response helpers",
    description:
      "Flags redirect(), noContent(), html(), and iterable() called with the event as their first argument.",
    why: 'H3 v2 response helpers build a response value and no longer take the event. Passing it shifts every argument: redirect(event, "/login") uses the event as the location, and html(event, markup) renders the event instead of the markup.',
    recommendedReplacement:
      'Drop the event argument and return the helper\'s result, such as return redirect("/login").',
    category: "response",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/migration",
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
        if (!canUseNativeH3(ctx, node.callee)) return;
        if (!isH3Call(ctx, node, eventlessHelpers) || !isHandlerEvent(ctx, node.arguments[0]))
          return;
        const name = h3ExportName(ctx, node.callee);
        const callee = sourceForNode(node.callee, ctx.file.text);
        const rest = node.arguments
          .slice(1)
          .map((argument: AnyNode) => sourceForNode(argument, ctx.file.text))
          .join(", ");
        report(
          ctx,
          node,
          "h3/response/no-event-first-arg",
          "error",
          "response",
          `${name}() in H3 v2 takes no event, so the event is read as its first argument and every other argument shifts.`,
          `Replace it with ${callee}(${rest}).`,
        );
      },
    };
  },
});
