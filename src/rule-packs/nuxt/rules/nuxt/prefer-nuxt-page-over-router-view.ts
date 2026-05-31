import { AnyNode, createRule, getElementName, simpleTagRenameFix } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const preferNuxtPageOverRouterView = createRule({
  meta: {
    id: "nuxt/routing/prefer-nuxtpage-over-routerview",
    title: "Use NuxtPage instead of RouterView",
    category: "routing",
    severity: "error",
    fixable: "safe",
    docsUrl: "https://nuxt.com/docs/4.x/api/components/nuxt-page#props",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || getElementName(node) !== "RouterView") return;
        ctx.report(
          diagnostics.NUXT0051({
            why: "<RouterView> bypasses NuxtPage behavior. Use <NuxtPage> in Nuxt app shells.",
            fix: "Replace <RouterView> with <NuxtPage>.",
          }),
          {
            ruleId: "nuxt/routing/prefer-nuxtpage-over-routerview",
            severity: "error",
            category: "routing",
            file: ctx.file.path,
            range: ctx.range(node),
            fix: simpleTagRenameFix(ctx.file.text, node, "NuxtPage"),
          },
        );
      },
    };
  },
});
