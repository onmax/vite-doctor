import { AnyNode, createRule, report } from "./shared.js";

export const preferUseIdForStableIds = createRule({
  meta: {
    id: "vue/ssr/use-id-for-stable-ids",
    title: "Use useId for SSR-stable ids",
    category: "ssr",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (ctx.project.framework === "nuxt") return;
    if (!ctx.project.ssr) return;
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name !== "Math.random" && name !== "Date.now") return;
        const nearby = ctx.file.text.slice(Math.max(0, node.start - 80), node.end + 80);
        if (!/\bid\b|for=|aria-|htmlFor/i.test(nearby)) return;
        report(
          ctx,
          node,
          "vue/ssr/use-id-for-stable-ids",
          "warn",
          "ssr",
          "Generated ids rendered during SSR must match during hydration.",
          "Use Vue's useId() for stable SSR-safe ids.",
        );
      },
    };
  },
});
