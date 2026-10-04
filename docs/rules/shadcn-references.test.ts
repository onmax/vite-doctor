import { runProjectFixture } from "../../src/core/testkit.js";
import { expect, test } from "vite-plus/test";
import { shadcnRulePack } from "../../src/rule-packs/shadcn/index.js";
import { diagnostics, diagnosticCodesByRuleId } from "../../src/rule-packs/shadcn/diagnostics.js";
import {
  getDiagnosticDocuments,
  getRuleDocuments,
  diagnosticsCollectionSource,
  rulesCollectionSource,
} from "./source.js";

test.each(shadcnRulePack.rules)("documents helper-authored $meta.id", async (rule) => {
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
  expect(ruleMarkdown).toContain(`vite-doctor . --extends shadcn/strict --rules ${rule.meta.id}`);

  const emitted = diagnostics[code]({ why: "Source finding", fix: "Apply the Rule remediation" });
  const reference = getDiagnosticDocuments().find(
    (entry) => entry.path === new URL(emitted.docs!).pathname,
  );
  expect(reference).toMatchObject({ code, ruleId: rule.meta.id, rulePath: document!.path });
  expect(await diagnosticsCollectionSource.getKeys()).toContain(reference!.key);
  const markdown = await diagnosticsCollectionSource.getItem(reference!.key);
  expect(markdown).toContain(rule.meta.title);
  expect(markdown).toContain(rule.meta.docsUrl);
  expect(markdown).toContain(`vite-doctor . --extends shadcn/strict --rules ${rule.meta.id}`);
});

test.each(shadcnRulePack.rules)(
  "the documented replacement clears $meta.id without a theme",
  async (rule) => {
    const document = getRuleDocuments().find((entry) => entry.id === rule.meta.id)!;
    const componentRule = ["shadcn/no-restyle", "shadcn/require-static-classes"].includes(
      rule.meta.id,
    );
    const options = componentRule ? { componentImports: ["^@/components/ui/"] } : {};
    for (const example of document.examples) {
      const diagnose = (source: string) =>
        runProjectFixture({
          rules: [rule],
          config: { rules: { [rule.meta.id]: ["warn", options] } },
          framework: "vite",
          files: { "src/Example.tsx": source },
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
