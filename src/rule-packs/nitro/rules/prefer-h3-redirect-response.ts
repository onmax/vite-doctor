import { type AnyNode, createRule, report } from "./shared.js";

export const preferH3RedirectResponse = createRule({
  meta: {
    id: "nitro/h3/prefer-redirect-response",
    title: "Return H3 v2 redirect responses",
    description: "H3 v2 prefers returned redirect() responses over sendRedirect(event, ...).",
    why: "The H3 v2 response model uses returned Web API response values while sendRedirect remains a compatibility wrapper.",
    recommendedReplacement: "Return redirect(location, status) from the handler.",
    category: "migration",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/migration",
    requires: { script: true, nitro: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "h3" && node.source?.value !== "nitro/h3") return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.imported?.name !== "sendRedirect") continue;
          report(
            ctx,
            specifier,
            "nitro/h3/prefer-redirect-response",
            "warn",
            "migration",
            "sendRedirect(event, ...) is an H3 v2 compatibility utility.",
            "Import redirect and return redirect(location, status) from the handler.",
          );
        }
      },
    };
  },
});
