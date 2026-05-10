import {
  AnyNode,
  createRule,
  getDirectiveExpression,
  getElementName,
  getStaticAttr,
  report,
  sourceForNode,
} from "./shared.js";

export const noRouteObjectPageKey = createRule({
  meta: {
    id: "nuxt/routing/no-route-object-page-key",
    title: "Do not use route objects as NuxtPage page keys",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    const reportNode = (node: AnyNode) =>
      report(
        ctx,
        node,
        "nuxt/routing/no-route-object-page-key",
        "warn",
        "routing",
        "Using the route object as a NuxtPage page key can diverge from Nuxt's Suspense-backed page lifecycle.",
        "Use a stable string key derived from route params or explicit page metadata.",
      );
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || getElementName(node) !== "NuxtPage") return;
        const snippet = sourceForNode(node, ctx.file.text);
        const pageKey =
          getDirectiveExpression(node, "bind", "page-key", ctx.file.text) ??
          getStaticAttr(node, "page-key");
        if (!/\bpage-key\b/.test(snippet) || !/\b(\$route|route)\b/.test(pageKey ?? snippet))
          return;
        reportNode(node);
      },
    };
  },
});
