import { expect, test } from "vite-plus/test";
import {
  getDiagnosticDocuments,
  getRuleDocuments,
  diagnosticsCollectionSource,
  rulesCollectionSource,
} from "./source.js";
import { htmlButtonHasType } from "../../src/rule-packs/vue/rules/vue/html-button-has-type.js";
import { preferSameNamePropShorthand } from "../../src/rule-packs/vue/rules/vue/prefer-same-name-prop-shorthand.js";
import { preferTrueAttributeShorthand } from "../../src/rule-packs/vue/rules/vue/prefer-true-attribute-shorthand.js";
import { preferUseEventListener } from "../../src/rule-packs/vue/rules/vue/prefer-use-event-listener.js";
import { diagnostics } from "../../src/rule-packs/vue/diagnostics.js";

test.each([
  [htmlButtonHasType, "VUE0022"],
  [preferSameNamePropShorthand, "VUE0023"],
  [preferTrueAttributeShorthand, "VUE0024"],
  [preferUseEventListener, "VUE0025"],
] as const)("documents the constant ID in $0.meta.id", async (rule, code) => {
  const document = getRuleDocuments().find((entry) => entry.id === rule.meta.id);
  expect(document).toMatchObject({
    id: rule.meta.id,
    title: rule.meta.title,
    diagnosticCodes: [code],
  });
  expect(await rulesCollectionSource.getItem(document!.key)).toContain(rule.meta.title);

  const emitted = diagnostics[code]({ why: "Source finding", fix: "Apply the Rule remediation" });
  const path = new URL(emitted.docs!).pathname;
  const reference = getDiagnosticDocuments().find((entry) => entry.path === path);
  expect(reference).toMatchObject({ code, ruleId: rule.meta.id, rulePath: document!.path });
  expect(await diagnosticsCollectionSource.getKeys()).toContain(reference!.key);
  const markdown = await diagnosticsCollectionSource.getItem(reference!.key);
  expect(markdown).toContain(rule.meta.docsUrl);
  expect(markdown).toContain(rule.meta.id);
});
