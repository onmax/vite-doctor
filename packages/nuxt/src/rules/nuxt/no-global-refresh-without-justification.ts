import { AnyNode, createRule, report } from "./shared.js";
import { hasGlobalRefreshIntentionalMarker, isInsideRouteHook } from "./async-data.js";

export const noGlobalRefreshWithoutJustification = createRule({
  meta: {
    id: "nuxt/no-global-refresh-without-justification",
    title: "Avoid unscoped refreshNuxtData calls",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/utils/refresh-nuxt-data#refresh-all-data",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "refreshNuxtData")) return;
        if ((node.arguments?.length ?? 0) > 0) return;
        if (hasGlobalRefreshIntentionalMarker(ctx, node)) return;
        const highBlastRadius =
          /(^|\/)(plugins|middleware)\//.test(ctx.file.relativePath) ||
          isInsideRouteHook(ctx, node);
        report(
          ctx,
          node,
          "nuxt/no-global-refresh-without-justification",
          highBlastRadius ? "error" : "warn",
          "fetching",
          "refreshNuxtData() without keys refreshes every active async-data entry.",
          "Pass a specific key or key list. If global refresh is intentional, add a nuxt-doctor: global-refresh-intentional comment.",
        );
      },
    };
  },
});
