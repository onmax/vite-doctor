import { afterEach, expect, test, vi } from "vite-plus/test";
import { noRefAsOperand } from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";

const tsParses = vi.hoisted(() => ({ count: 0 }));

vi.mock("@typescript-eslint/parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("@typescript-eslint/parser")>();
  const parseForESLint: typeof original.parseForESLint = (code, options) => {
    tsParses.count++;
    return original.parseForESLint(code, options);
  };
  return { ...original, parseForESLint, default: { ...original, parseForESLint } };
});

afterEach(() => {
  tsParses.count = 0;
});

test("the eslint-plugin-vue bridge parses template expressions without TypeScript", async () => {
  const result = await runRuleFixture({
    rule: noRefAsOperand,
    framework: "vue",
    files: {
      "app.vue": `<script setup lang="ts">
import { ref } from 'vue'
const count = ref(0)
const doubled = count + 1
</script>
<template>
  <p :title="String(count)" @click="count++">{{ doubled }} {{ count }} {{ count + 1 }}</p>
  <span v-if="count > 1">{{ (count as number) }}</span>
</template>`,
    },
  });

  // The bridge's <script> parse is the only one; the core template parse no longer uses TypeScript.
  expect(tsParses.count).toBe(1);
  expect(
    result.diagnostics.map((diagnostic) => [diagnostic.ruleId, diagnostic.range?.line]),
  ).toEqual([["vue/reactivity/no-ref-as-operand", 4]]);
});

test("the bridge keeps TypeScript for plain JavaScript script blocks only", async () => {
  const result = await runRuleFixture({
    rule: noRefAsOperand,
    framework: "vue",
    files: {
      "app.vue": `<script setup>
import { ref } from 'vue'
const open = ref(false)
if (open) console.log('open')
</script>
<template><button @click="open = !open">{{ open }}</button></template>`,
    },
  });

  expect(tsParses.count).toBe(1);
  expect(
    result.diagnostics.map((diagnostic) => [diagnostic.ruleId, diagnostic.range?.line]),
  ).toEqual([["vue/reactivity/no-ref-as-operand", 4]]);
});
