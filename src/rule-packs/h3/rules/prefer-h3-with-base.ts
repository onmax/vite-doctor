import { type AnyNode, createRule, report } from "./shared.js";

export const preferH3WithBase = createRule({
  meta: {
    id: "h3/migration/prefer-with-base",
    title: "Replace H3 v2 useBase",
    description: "H3 v2 renamed useBase() to withBase().",
    why: "H3 v2 documents withBase() as the handler wrapper for mounting an application under a path prefix, while useBase() remains a legacy alias.",
    recommendedReplacement:
      "Import withBase and replace useBase(base, handler) with withBase(base, handler).",
    category: "migration",
    severity: "warn",
    confidence: "proven",
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
          if (specifier.imported?.name !== "useBase") continue;
          report(
            ctx,
            specifier,
            "h3/migration/prefer-with-base",
            "warn",
            "migration",
            "H3 v2 renamed useBase() to withBase().",
            "Import withBase and replace useBase(base, handler) with withBase(base, handler).",
          );
        }
      },
    };
  },
});
