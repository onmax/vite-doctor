import { createRule, report } from "./shared.js";

export const dataAllowMismatchSurgical = createRule({
  meta: {
    id: "vue/ssr/data-allow-mismatch-surgical",
    title: "Use data-allow-mismatch only surgically",
    category: "ssr",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/scaling-up/ssr.html#suppressing-hydration-mismatches",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      template: {
        element(node) {
          if (!ctx.helpers.hasVueAttribute(node, "data-allow-mismatch")) return;
          const start = node.loc.start.offset;
          const end = node.loc.end.offset;
          const snippet = ctx.file.text.slice(Math.max(0, start - 120), end + 80);
          if (
            /doctor-allow-mismatch|allow-mismatch-reason|hydration mismatch reason/i.test(snippet)
          )
            return;
          report(
            ctx,
            node,
            "vue/ssr/data-allow-mismatch-surgical",
            "warn",
            "ssr",
            "data-allow-mismatch should be a narrow hydration escape hatch with an explicit reason.",
            "Add a nearby reason comment or fix the underlying SSR/client divergence.",
          );
        },
      },
    };
  },
});
