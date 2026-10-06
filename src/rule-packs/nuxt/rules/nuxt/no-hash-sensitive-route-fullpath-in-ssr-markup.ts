import { createRule, isClientOnlyPath, isNuxtRuntimeFile, report } from "./shared.js";

export const noHashSensitiveRouteFullpathInSsrMarkup = createRule({
  meta: {
    id: "nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup",
    title: "Avoid route.fullPath in SSR markup",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/api/composables/use-route#hydration-issues-with-routefullpath",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      template: {
        element(node) {
          if (!/\b(\$route|route)\.fullPath\b/.test(node.loc.source)) return;
          report(
            ctx,
            node,
            "nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup",
            "warn",
            "routing",
            "route.fullPath can include URL fragments that are unavailable during SSR and can cause hydration drift.",
            "Use path, params, or query values that are available on both server and client.",
          );
        },
      },
    };
  },
});
