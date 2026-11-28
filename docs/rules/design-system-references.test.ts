import { runProjectFixture } from "../../src/core/testkit.js";
import { expect, test } from "vite-plus/test";
import { designSystemRulePack } from "../../src/rule-packs/design-system/index.js";
import {
  diagnostics,
  diagnosticCodesByRuleId,
} from "../../src/rule-packs/design-system/diagnostics.js";
import {
  getDiagnosticDocuments,
  getRuleDocuments,
  diagnosticsCollectionSource,
  rulesCollectionSource,
} from "./source.js";

const PRIMARY_UBUTTON_LIMIT = {
  when: { variant: ["solid", null], color: ["primary", null] },
  max: 1,
  why: "Two solid primary buttons compete, so users can't tell which action moves them forward.",
  fix: 'Keep one primary action and give the others variant="outline" or color="neutral".',
};

test.each(designSystemRulePack.rules)("documents helper-authored $meta.id", async (rule) => {
  const code = diagnosticCodesByRuleId[rule.meta.id as keyof typeof diagnosticCodesByRuleId];
  const document = getRuleDocuments().find((entry) => entry.id === rule.meta.id);
  expect(document).toMatchObject({
    title: rule.meta.title,
    description: rule.meta.description,
    severity: rule.meta.severity,
    category: rule.meta.category,
    fixable: rule.meta.fixable,
    docsUrl: rule.meta.docsUrl,
    diagnosticCodes: [code],
  });
  const ruleMarkdown = await rulesCollectionSource.getItem(document!.key);
  expect(ruleMarkdown).toContain(rule.meta.docsUrl);
  expect(ruleMarkdown).toContain(
    `vite-doctor . --extends design-system/strict --rules ${rule.meta.id}`,
  );

  const emitted = diagnostics[code]({ why: "Source finding", fix: "Apply the Rule remediation" });
  const reference = getDiagnosticDocuments().find(
    (entry) => entry.path === new URL(emitted.docs!).pathname,
  );
  expect(reference).toMatchObject({ code, ruleId: rule.meta.id, rulePath: document!.path });
  expect(await diagnosticsCollectionSource.getKeys()).toContain(reference!.key);
  const markdown = await diagnosticsCollectionSource.getItem(reference!.key);
  expect(markdown).toContain(rule.meta.title);
  expect(markdown).toContain(rule.meta.docsUrl);
  expect(markdown).toContain(
    `vite-doctor . --extends design-system/strict --rules ${rule.meta.id}`,
  );
});

test.each(designSystemRulePack.rules)(
  "the documented replacement clears $meta.id without a theme",
  async (rule) => {
    const document = getRuleDocuments().find((entry) => entry.id === rule.meta.id)!;
    const componentRule = [
      "design-system/no-restyle",
      "design-system/require-static-classes",
    ].includes(rule.meta.id);
    // Limits are counted per Nuxt route, so its example is a page with a contract in config.
    const perView = rule.meta.id === "design-system/limit-per-view";
    const options = componentRule
      ? { componentImports: ["^@/components/ui/"] }
      : perView
        ? { contracts: { UButton: { limits: [PRIMARY_UBUTTON_LIMIT] } } }
        : {};
    for (const example of document.examples) {
      const vue = example.language === "vue";
      const diagnose = (source: string) =>
        runProjectFixture({
          rules: [rule],
          config: { rules: { [rule.meta.id]: ["warn", options] } },
          framework: perView ? "nuxt" : vue ? "vue" : "vite",
          ...(vue && { dependencies: { "@nuxt/ui": "^4.0.0" } }),
          files: {
            [perView ? "app/pages/index.vue" : vue ? "src/Example.vue" : "src/Example.tsx"]: source,
          },
        });
      const before = await diagnose(example.invalid);
      const after = await diagnose(example.valid);
      expect(before.diagnostics.some((diagnostic) => diagnostic.ruleId === rule.meta.id)).toBe(
        true,
      );
      expect(after.diagnostics.filter((diagnostic) => diagnostic.ruleId === rule.meta.id)).toEqual(
        [],
      );
    }
  },
);
