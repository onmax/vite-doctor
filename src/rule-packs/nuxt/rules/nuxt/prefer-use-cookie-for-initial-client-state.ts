import { AnyNode, createRule, isClientOnlyPath, isNuxtRuntimeFile, report } from "./shared.js";

export const preferUseCookieForInitialClientState = createRule({
  meta: {
    id: "nuxt/hydration/prefer-usecookie-for-initial-client-state",
    title: "Use useCookie for SSR-visible browser preference state",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-cookie#basic-usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (
          !ctx.helpers.isCall(node) ||
          !["localStorage.getItem", "sessionStorage.getItem"].includes(
            ctx.helpers.getCalleeName(node) ?? "",
          )
        )
          return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        report(
          ctx,
          node,
          "nuxt/hydration/prefer-usecookie-for-initial-client-state",
          "warn",
          "hydration",
          "Reading browser storage for initial render state can mismatch SSR markup.",
          "Use useCookie() for user preference state that affects initial SSR-rendered UI.",
        );
      },
    };
  },
});
