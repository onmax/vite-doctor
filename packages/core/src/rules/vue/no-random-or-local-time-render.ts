import { AnyNode, createRule, report } from "./shared.js";

export const noRandomOrLocalTimeRender = createRule({
  meta: {
    id: "vue/ssr/no-random-or-local-time-render",
    title: "Avoid random or local-time SSR render values",
    category: "ssr",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (
          name !== "Math.random" &&
          name !== "Date.now" &&
          !(node.type === "NewExpression" && node.callee?.name === "Date")
        )
          return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        report(
          ctx,
          node,
          "vue/ssr/no-random-or-local-time-render",
          "warn",
          "ssr",
          "Random or local-time values rendered during SSR can differ during hydration.",
          "Create stable server state, defer to mounted client code, or isolate with data-allow-mismatch.",
        );
      },
    };
  },
});
