import { AnyNode, createRule, report } from "./shared.js";

export const preferSeoComposables = createRule({
  meta: {
    id: "nuxt/seo/prefer-seo-composables",
    title: "Use Nuxt SEO composables for metadata",
    category: "seo",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/\b(title|description|ogTitle|ogDescription|meta)\b/.test(snippet)) return;
        report(
          ctx,
          node,
          "nuxt/seo/prefer-seo-composables",
          "warn",
          "seo",
          "SEO metadata is safer and better typed through Nuxt SEO composables.",
          "Use useSeoMeta() for SEO metadata and useHeadSafe() for untrusted values.",
        );
      },
    };
  },
});
