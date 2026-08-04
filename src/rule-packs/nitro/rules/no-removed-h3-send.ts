import { type AnyNode, createRule, report } from "./shared.js";

export const noRemovedH3Send = createRule({
  meta: {
    id: "nitro/h3/no-removed-send",
    title: "Replace removed H3 send utilities",
    description:
      "H3 v2 removes send() and sendError() in favor of returned values and thrown errors.",
    why: "H3 v2 handlers use Web API response values and HTTPError instead of imperative send helpers.",
    recommendedReplacement:
      "Return the response value from the handler, or throw an HTTPError for an error response.",
    category: "migration",
    severity: "error",
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
          const imported = specifier.imported?.name;
          if (imported !== "send" && imported !== "sendError") continue;
          report(
            ctx,
            specifier,
            "nitro/h3/no-removed-send",
            "error",
            "migration",
            `H3 v2 removes ${imported}().`,
            imported === "send"
              ? "Return the response value from the handler."
              : "Throw an HTTPError from the handler.",
          );
        }
      },
    };
  },
});
