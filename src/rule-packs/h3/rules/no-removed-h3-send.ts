import {
  type AnyNode,
  createRule,
  h3ExportName,
  isH3HandlerFile,
  isH3Source,
  report,
} from "./shared.js";

export const noRemovedH3Send = createRule({
  meta: {
    id: "h3/migration/no-removed-send",
    title: "Replace removed H3 send utilities",
    description:
      "H3 v2 removes send() and sendError() in favor of returned values and thrown errors.",
    why: "H3 v2 handlers use Web API response values and HTTPError instead of imperative send helpers.",
    recommendedReplacement:
      "Return the response value from the handler, or throw an HTTPError for an error response.",
    category: "migration",
    severity: "error",
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
    const reportRemoved = (node: AnyNode, imported: string) =>
      report(
        ctx,
        node,
        "h3/migration/no-removed-send",
        "error",
        "migration",
        `H3 v2 removes ${imported}().`,
        imported === "send"
          ? "Return the response value from the handler."
          : "Throw an HTTPError from the handler.",
      );
    return {
      MemberExpression(node: AnyNode) {
        const imported = h3ExportName(ctx, node);
        if (imported === "send" || imported === "sendError") reportRemoved(node, imported);
      },
      ImportDeclaration(node: AnyNode) {
        if (node.importKind === "type" || !isH3Source(node.source?.value)) return;
        for (const specifier of node.specifiers ?? []) {
          const imported = specifier.imported?.name;
          if (specifier.importKind === "type") continue;
          if (imported !== "send" && imported !== "sendError") continue;
          reportRemoved(specifier, imported);
        }
      },
    };
  },
});
