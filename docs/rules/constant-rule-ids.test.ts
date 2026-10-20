import { expect, test } from "vite-plus/test";
import {
  getDiagnosticDocuments,
  getRuleDocuments,
  diagnosticsCollectionSource,
  rulesCollectionSource,
  findMetaObjects,
} from "./source.js";
import { htmlButtonHasType } from "../../src/rule-packs/vue/rules/vue/html-button-has-type.js";
import { preferSameNamePropShorthand } from "../../src/rule-packs/vue/rules/vue/prefer-same-name-prop-shorthand.js";
import { preferTrueAttributeShorthand } from "../../src/rule-packs/vue/rules/vue/prefer-true-attribute-shorthand.js";
import { preferUseEventListener } from "../../src/rule-packs/vue/rules/vue/prefer-use-event-listener.js";
import { requireUsePrefix } from "../../src/rule-packs/vue/rules/vue/require-use-prefix.js";

import { noMutatingProps } from "../../src/rule-packs/vue/rules/vue/no-mutating-props.js";
import { noComputedSideEffects } from "../../src/rule-packs/vue/rules/vue/no-computed-side-effects.js";
import { noVIfWithVFor } from "../../src/rule-packs/vue/rules/vue/no-v-if-with-v-for.js";
import { noDuplicateAttrInheritance } from "../../src/rule-packs/vue/rules/vue/no-duplicate-attr-inheritance.js";
import { noRequiredPropWithDefault } from "../../src/rule-packs/vue/rules/vue/no-required-prop-with-default.js";

import { noWatchUseAttrs } from "../../src/rule-packs/vue/rules/vue/no-watch-use-attrs.js";
import { noReactiveDestructure } from "../../src/rule-packs/vue/rules/vue/no-reactive-destructure.js";
import { preferComputedOverWatchAssign } from "../../src/rule-packs/vue/rules/vue/prefer-computed-over-watch-assign.js";

import { diagnostics } from "../../src/rule-packs/vue/diagnostics.js";
import { parseSync, visitorKeys } from "oxc-parser";

test("does not resolve IDs shadowed in unbraced local scopes", () => {
  const ast = parseSync(
    "fixture.ts",
    `const RULE_ID = "module/rule";
      consume({ meta: { id: RULE_ID } });
      for (const RULE_ID of ["local/rule"]) consume({ meta: { id: RULE_ID } });
      switch (value) { case 1: const RULE_ID = "case/rule"; consume({ meta: { id: RULE_ID } }); }`,
    { sourceType: "module", lang: "ts" },
  );
  expect(findMetaObjects(ast.program, visitorKeys).map(({ id }) => id)).toEqual(["module/rule"]);
});

test.each([
  [htmlButtonHasType, "VUE0022"],
  [preferSameNamePropShorthand, "VUE0023"],
  [preferTrueAttributeShorthand, "VUE0024"],
  [preferUseEventListener, "VUE0025"],
  [requireUsePrefix, "VUE0026"],

  [noMutatingProps, "VUE0027"],
  [noComputedSideEffects, "VUE0028"],
  [noVIfWithVFor, "VUE0029"],
  [noDuplicateAttrInheritance, "VUE0030"],
  [noRequiredPropWithDefault, "VUE0031"],

  [noWatchUseAttrs, "VUE0032"],
  [noReactiveDestructure, "VUE0033"],
  [preferComputedOverWatchAssign, "VUE0034"],
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
