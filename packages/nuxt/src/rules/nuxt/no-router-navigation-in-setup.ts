import { AnyNode, createRule, report } from "./shared.js";

export const noRouterNavigationInSetup = createRule({
  meta: {
    id: "nuxt/routing/no-router-navigation-in-setup",
    title: "Do not navigate with router.push/replace during setup",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!["router.push", "router.replace"].includes(ctx.helpers.getCalleeName(node) ?? ""))
          return;
        if (ctx.file.isVueSfc && !ctx.helpers.isLikelyEventHandler(ctx.file.text, node.start)) {
          report(
            ctx,
            node,
            "nuxt/routing/no-router-navigation-in-setup",
            "warn",
            "routing",
            `${ctx.helpers.getCalleeName(node)}() appears to run during setup. Trigger navigation from a client event/lifecycle guard, route middleware, or use navigateTo() in universal contexts.`,
          );
        }
      },
    };
  },
});
