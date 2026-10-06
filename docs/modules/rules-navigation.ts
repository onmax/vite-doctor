import { addTemplate, addTypeTemplate, defineNuxtModule } from "@nuxt/kit";
import { getDiagnosticDocuments, getRuleDocuments } from "../rules/source.js";

// The sidebar and search need every rule and diagnostic. Shipping them as a
// build-time module keeps them in one cached client chunk instead of
// serializing the same entries into every prerendered page payload.
export default defineNuxtModule({
  meta: { name: "rules-navigation" },
  setup() {
    addTemplate({
      filename: "rules-navigation-entries.mjs",
      getContents: () => {
        const rules = getRuleDocuments().map((rule) => ({
          path: rule.path,
          title: rule.title || rule.id,
          navigation: { title: rule.navigationTitle },
          ruleId: rule.id,
          category: rule.category,
          framework: rule.framework,
        }));
        const diagnostics = getDiagnosticDocuments().map((diagnostic) => ({
          code: diagnostic.code,
          ruleId: diagnostic.ruleId,
          framework: diagnostic.framework,
        }));
        return `export const rules = ${JSON.stringify(rules)};\nexport const diagnostics = ${JSON.stringify(diagnostics)};\n`;
      },
    });
    addTypeTemplate({
      filename: "types/rules-navigation-entries.d.ts",
      getContents: () =>
        [
          'declare module "#build/rules-navigation-entries.mjs" {',
          '  import type { DiagnosticNavigationEntry, RuleNavigationEntry } from "~/utils/rules-navigation";',
          "  export const rules: RuleNavigationEntry[];",
          "  export const diagnostics: DiagnosticNavigationEntry[];",
          "}",
        ].join("\n"),
    });
  },
});
