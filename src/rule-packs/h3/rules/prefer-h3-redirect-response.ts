import {
  canUseNativeH3,
  canUseNativeH3Source,
  type AnyNode,
  createRule,
  h3ExportName,
  isH3HandlerFile,
  isH3Source,
  report,
} from "./shared.js";

export const preferH3RedirectResponse = createRule({
  meta: {
    id: "h3/migration/prefer-redirect-response",
    title: "Return H3 v2 redirect responses",
    description: "H3 v2 prefers returned redirect() responses over sendRedirect(event, ...).",
    why: "The H3 v2 response model uses returned Web API response values while sendRedirect remains a compatibility wrapper.",
    recommendedReplacement: "Return redirect(location, status) from the handler.",
    category: "migration",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/migration",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    const reportUse = (node: AnyNode) =>
      report(
        ctx,
        node,
        "h3/migration/prefer-redirect-response",
        "warn",
        "migration",
        "sendRedirect(event, ...) is an H3 v2 compatibility utility.",
        "Import redirect and return redirect(location, status) from the handler.",
      );
    return {
      MemberExpression(node: AnyNode) {
        if (canUseNativeH3(ctx, node) && h3ExportName(ctx, node) === "sendRedirect")
          reportUse(node);
      },
      ImportDeclaration(node: AnyNode) {
        if (
          node.importKind === "type" ||
          !isH3Source(node.source?.value) ||
          !canUseNativeH3Source(ctx, node.source.value)
        )
          return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.importKind !== "type" && specifier.imported?.name === "sendRedirect")
            reportUse(specifier);
        }
      },
    };
  },
});
