import { AnyNode, createRule, isClientOnlyPath, report } from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";

export const noRouterNavigationInSetup = createRule({
  meta: {
    id: "nuxt/routing/no-router-navigation-in-setup",
    title: "Do not navigate with router.push/replace during setup",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/utils/navigate-to#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    if (!evidence.isRuntimeAppFile() || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!["router.push", "router.replace"].includes(ctx.helpers.getCalleeName(node) ?? ""))
          return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        if (evidence.isClientCallable(node)) return;
        if (ctx.file.isVueSfc && !ctx.helpers.isLikelyEventHandler(ctx.file.text, node.start)) {
          report(
            ctx,
            node,
            "nuxt/routing/no-router-navigation-in-setup",
            "warn",
            "routing",
            `${ctx.helpers.getCalleeName(node)}() appears to run during setup. Trigger navigation from a client event/lifecycle guard, route middleware, or use navigateTo() in universal contexts.`,
            "Move navigation into a client event, lifecycle guard, route middleware, or navigateTo().",
          );
        }
      },
    };
  },
});
