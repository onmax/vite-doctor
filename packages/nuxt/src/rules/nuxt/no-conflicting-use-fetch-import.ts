import { AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const noConflictingUseFetchImport = createRule({
  meta: {
    id: "nuxt/imports/no-conflicting-usefetch-import",
    title: "Do not shadow Nuxt useFetch",
    category: "imports",
    severity: "error",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value === "#imports" || node.source?.value === "nuxt/app") return;
        for (const specifier of node.specifiers ?? []) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported?.name === "useFetch" &&
            specifier.local?.name === "useFetch"
          ) {
            ctx.report(
              diagnostics.NUXT0035.report({
                why: "This imports useFetch from a non-Nuxt source and can shadow Nuxt's SSR-aware useFetch(). Rename it or use Nuxt's auto-import.",
                fix: "Rename imported useFetch to useVueUseFetch.",
              }),
              {
                ruleId: "nuxt/imports/no-conflicting-usefetch-import",
                severity: "error",
                category: "imports",
                file: ctx.file.path,
                range: ctx.range(specifier),
                fix: {
                  kind: "safe",
                  message: "Rename imported useFetch to useVueUseFetch.",
                  edits: [
                    {
                      range: { start: specifier.local.start, end: specifier.local.end },
                      text: "useVueUseFetch",
                    },
                  ],
                },
              },
            );
          }
        }
      },
    };
  },
});
