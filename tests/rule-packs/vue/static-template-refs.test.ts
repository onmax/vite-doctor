import { expect, test } from "vite-plus/test";
import { runVueSfcRuleFixture } from "../../../src/core/testkit.ts";
import { preferUseTemplateRef } from "../../../src/rule-packs/vue/rules/vue/prefer-use-template-ref.ts";

test.each([
  '<button :ref="name" />',
  '<button v-bind:ref="name" />',
  '<button data-ref="name" />',
  '<!-- <button ref="name" /> -->',
  "<button title=\"ref='name'\" />",
  '<div>{{ `ref="name"` }}</div>',
])("ignores text and dynamic refs: %s", async (template) => {
  const result = await runVueSfcRuleFixture(
    preferUseTemplateRef,
    `<script setup>const name = ref('button')</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toEqual([]);
});

test("ignores a ref-like string in the script block", async () => {
  const result = await runVueSfcRuleFixture(
    preferUseTemplateRef,
    `<script setup>const name = ref(null); const sample = 'ref="name"'</script><template><button /></template>`,
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  '<button ref="name" />',
  "<button ref='name' />",
  '<button ref = "name" />',
  '<button ref\n=\n"name" />',
  '<div><section><button ref="name" /></section></div>',
  '<button v-if="visible" ref="name" /><button v-else ref="name" />',
])("finds a static template ref without duplicate suggestions: %s", async (template) => {
  const result = await runVueSfcRuleFixture(
    preferUseTemplateRef,
    `<script setup>const name = ref(null)</script><template>${template}</template>`,
  );
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    preferUseTemplateRef.meta.id,
  ]);
  expect(result.diagnostics[0]!.message).toContain("useTemplateRef");
});

test("suggests each static ref at its own declaration", async () => {
  const source =
    '<script setup>const first = ref(null); const second = ref(null)</script><template><div ref="first"><button ref="second" /></div></template>';
  const result = await runVueSfcRuleFixture(preferUseTemplateRef, source);
  expect(result.diagnostics).toHaveLength(2);
  expect(
    result.diagnostics.map((diagnostic) =>
      source.slice(diagnostic.range!.start, diagnostic.range!.end),
    ),
  ).toEqual(["first = ref(null)", "second = ref(null)"]);
});
