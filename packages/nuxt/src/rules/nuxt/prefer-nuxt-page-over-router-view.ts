import { AnyNode, createRule, getElementName, simpleTagRenameFix } from "./shared.js";

export const preferNuxtPageOverRouterView = createRule({
  meta: {
    id: "nuxt/routing/prefer-nuxtpage-over-routerview",
    title: "Use NuxtPage instead of RouterView",
    category: "routing",
    severity: "error",
    fixable: "safe",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || getElementName(node) !== "RouterView") return;
        ctx.report({
          ruleId: "nuxt/routing/prefer-nuxtpage-over-routerview",
          severity: "error",
          category: "routing",
          file: ctx.file.path,
          range: ctx.range(node),
          message: "<RouterView> bypasses NuxtPage behavior. Use <NuxtPage> in Nuxt app shells.",
          suggestion: "Replace <RouterView> with <NuxtPage>.",
          fix: simpleTagRenameFix(ctx.file.text, node, "NuxtPage"),
        });
      },
    };
  },
});
