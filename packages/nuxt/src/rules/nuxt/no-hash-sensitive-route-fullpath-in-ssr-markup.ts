import {
  AnyNode,
  createRule,
  isClientOnlyPath,
  isNuxtRuntimeFile,
  report,
  templateExpressions,
} from "./shared.js";

export const noHashSensitiveRouteFullpathInSsrMarkup = createRule({
  meta: {
    id: "nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup",
    title: "Avoid route.fullPath in SSR markup",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement") return;
        if (
          !templateExpressions(node, ctx.file.text).some((text) =>
            /\b(\$route|route)\.fullPath\b/.test(text),
          )
        )
          return;
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
    };
  },
});
