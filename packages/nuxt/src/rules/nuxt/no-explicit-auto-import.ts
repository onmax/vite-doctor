import { AnyNode, NUXT_AUTO_IMPORTS, createRule, includeTrailingNewline } from "./shared.js";

export const noExplicitAutoImport = createRule({
  meta: {
    id: "nuxt/imports/no-explicit-auto-import",
    title: "Avoid explicit imports of Nuxt auto-imports",
    category: "imports",
    severity: "info",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "#imports") return;
        const specifiers =
          node.specifiers?.filter((specifier: AnyNode) =>
            NUXT_AUTO_IMPORTS.has(specifier.imported?.name),
          ) ?? [];
        if (!specifiers.length) return;
        const all = specifiers.length === node.specifiers.length;
        ctx.report({
          ruleId: "nuxt/imports/no-explicit-auto-import",
          severity: "info",
          category: "imports",
          file: ctx.file.path,
          range: ctx.range(node),
          message:
            "This imports symbols that Nuxt already auto-imports. Keeping code auto-imported is the Nuxt default; configure this rule off if your team prefers explicit #imports.",
          suggestion: "Remove the explicit #imports import when all specifiers are auto-imported.",
          fix: all
            ? {
                kind: "safe",
                edits: [
                  {
                    range: {
                      start: node.start,
                      end: includeTrailingNewline(ctx.file.text, node.end),
                    },
                    text: "",
                  },
                ],
              }
            : null,
        });
      },
    };
  },
});
