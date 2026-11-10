import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noConstantComputed } from "../../../src/rule-packs/vue/rules/vue/no-constant-computed.ts";

test("reports computed getters that return a literal", async () => {
  const result = await runRuleFixture({
    framework: "vue",
    rule: noConstantComputed,
    files: {
      "src/Heading.vue": `<script setup lang="ts">
import { computed } from "vue"
const heading = computed(() => "Upcoming events")
const limit = computed(() => { return 12 })
</script>
<template><h1>{{ heading }} {{ limit }}</h1></template>`,
    },
  });

  expect(result.diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
    'This computed() always returns "Upcoming events". It reads no reactive source, so it never recomputes.',
    "This computed() always returns 12. It reads no reactive source, so it never recomputes.",
  ]);
}, 30_000);

test("allows computed getters that read reactive state", async () => {
  const result = await runRuleFixture({
    framework: "vue",
    rule: noConstantComputed,
    files: {
      "src/Count.vue": `<script setup lang="ts">
import { computed, ref } from "vue"
const props = defineProps<{ title: string }>()
const count = ref(0)
const label = computed(() => \`\${count.value} going\`)
const title = computed(() => props.title || "Untitled")
</script>
<template><p>{{ label }} {{ title }}</p></template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("preserves exported composable, ComputedRef and .value contracts in its advice", async () => {
  const result = await runRuleFixture({
    framework: "vue",
    rule: noConstantComputed,
    files: {
      "src/title.ts": `import { computed, type ComputedRef } from 'vue'
export function useTitle(): ComputedRef<string> { return computed(() => 'Untitled') }
export function useHeading() { return computed(() => 'Heading') }
const title = computed(() => 'Events')
console.log(title.value)`,
    },
  });
  expect(result.diagnostics).toHaveLength(3);
  for (const diagnostic of result.diagnostics) {
    expect(diagnostic.suggestion).toBe(
      "Keep computed() when consumers require a readonly ComputedRef or .value access. Use a plain const only when no ref contract is required.",
    );
  }
});

test("ignores generator and async getters whose results are not literals", async () => {
  const result = await runRuleFixture({
    framework: "vue",
    rule: noConstantComputed,
    files: {
      "src/iterators.ts": `import { computed } from 'vue'
const iterator = computed(function* () { return 12 })
const promise = computed(async () => 12)
const asyncIterator = computed(async function* () { return 12 })`,
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});
