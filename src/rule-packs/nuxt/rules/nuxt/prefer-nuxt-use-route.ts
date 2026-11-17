import { AnyNode, createRule, isNuxtRoutedAppFile } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const preferNuxtUseRoute = createRule({
  meta: {
    id: "nuxt/routing/prefer-nuxt-useroute",
    title: "Use Nuxt's useRoute in Nuxt app code",
    cacheScope: "none",
    category: "routing",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-route#route-synchronization-issues",
    requires: { script: true, nuxt: true },
  },
  async create(ctx) {
    const routed = await isNuxtRoutedAppFile(ctx);
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "vue-router") return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.imported?.name === "useRoute" && routed) {
            ctx.report(
              diagnostics.NUXT0049({
                why: "Nuxt wraps useRoute() so route state updates after page content changes. Do not import useRoute from vue-router in Nuxt app code.",
                fix: "Use Nuxt's auto-imported useRoute().",
              }),
              {
                ruleId: "nuxt/routing/prefer-nuxt-useroute",
                severity: "error",
                category: "routing",
                file: ctx.file.path,
                range: ctx.range(specifier),
              },
            );
          }
        }
      },
    };
  },
});
