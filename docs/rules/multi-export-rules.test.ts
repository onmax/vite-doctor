import { expect, test } from "vite-plus/test";
import {
  getDiagnosticDocuments,
  getRuleDocuments,
  diagnosticsCollectionSource,
  rulesCollectionSource,
} from "./source.js";
import {
  noUntranslatedText,
  noUnusedTranslations,
} from "../../src/rule-packs/vue/rules/vue/i18n.js";
import { diagnostics } from "../../src/rule-packs/vue/diagnostics.js";

test.each([
  [noUntranslatedText, "VUE0001"],
  [noUnusedTranslations, "VUE0002"],
] as const)("documents a Rule from the shared i18n export: $0.meta.id", async (rule, code) => {
  const documents = getRuleDocuments().filter((entry) => entry.id === rule.meta.id);
  expect(documents).toHaveLength(1);
  const [document] = documents;
  expect(document).toMatchObject({
    title: rule.meta.title,
    source: "src/rule-packs/vue/rules/vue/i18n.ts",
    diagnosticCodes: [code],
  });
  expect(await rulesCollectionSource.getKeys()).toContain(document!.key);
  expect(await rulesCollectionSource.getItem(document!.key)).toContain(rule.meta.id);

  const emitted = diagnostics[code]({ why: "Source finding", fix: "Apply the Rule remediation" });
  const path = new URL(emitted.docs!).pathname;
  const reference = getDiagnosticDocuments().find((entry) => entry.path === path);
  expect(reference).toMatchObject({ code, ruleId: rule.meta.id, rulePath: document!.path });
  expect(await diagnosticsCollectionSource.getKeys()).toContain(reference!.key);
  expect(await diagnosticsCollectionSource.getItem(reference!.key)).toContain(rule.meta.title);
});
