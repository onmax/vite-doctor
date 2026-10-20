import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { runVueSfcRuleFixture } from "../../rule-fixtures.ts";
import { preferComputedOverWatchAssign } from "../../../src/rule-packs/vue/rules/vue/prefer-computed-over-watch-assign.ts";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.ts";

const IMPORTS = "import { computed, ref, watch, watchEffect } from 'vue'";
const setup = (body: string, template = "", imports = IMPORTS) =>
  `<script setup lang="ts">\n${imports}\nconst count = ref(1)\n${body}\n</script>${template ? `\n<template>${template}</template>` : ""}`;

test.each([
  [
    "a watch callback value",
    "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 })",
  ],
  [
    "an expression-bodied callback",
    "const doubled = ref(0)\nwatch(count, (value) => (doubled.value = value * 2))",
  ],
  [
    "a getter source",
    "const label = ref('')\nwatch(() => count.value, () => { label.value = `#${count.value}` })",
  ],
  [
    "an immediate watch",
    "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 }, { immediate: true })",
  ],
  ["watchEffect", "const doubled = ref(0)\nwatchEffect(() => { doubled.value = count.value * 2 })"],
  [
    "a shallowRef target",
    "const doubled = shallowRef(0)\nwatch(count, (value) => { doubled.value = value * 2 })",
  ],
])("reports %s", async (_, body) => {
  const result = await runVueSfcRuleFixture(
    preferComputedOverWatchAssign,
    setup(body, "{{ doubled }}", `${IMPORTS}\nimport { shallowRef } from 'vue'`),
  );
  expect(result.diagnostics.map((diagnostic) => [diagnostic.ruleId, diagnostic.code])).toEqual([
    [preferComputedOverWatchAssign.meta.id, "VUE0034"],
  ]);
});

test("explains the lazy first run and suggests the computed", async () => {
  const lazy = await runVueSfcRuleFixture(
    preferComputedOverWatchAssign,
    setup("const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 })"),
  );
  expect(lazy.diagnostics[0]?.why).toContain("never during SSR");
  expect(lazy.diagnostics[0]?.suggestion).toContain("const doubled = computed(() => ...)");
  const effect = await runVueSfcRuleFixture(
    preferComputedOverWatchAssign,
    setup("const doubled = ref(0)\nwatchEffect(() => { doubled.value = count.value * 2 })"),
  );
  expect(effect.diagnostics[0]?.why).not.toContain("SSR");
  expect(effect.diagnostics[0]?.suggestion).toContain(
    "const doubled = computed(() => count.value * 2)",
  );
});

test.each([
  [
    "a callback with other effects",
    "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2; track(value) })",
  ],
  [
    "an async callback",
    "const doubled = ref(0)\nwatch(count, async (value) => { doubled.value = await load(value) })",
  ],
  [
    "a value from the old value",
    "const delta = ref(0)\nwatch(count, (value, old) => { delta.value = value - old })",
  ],
  [
    "a self-referencing assignment",
    "const total = ref(0)\nwatch(count, (value) => { total.value = total.value + value })",
  ],
  [
    "a ref written elsewhere",
    "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 })\nfunction reset() { doubled.value = 0 }",
  ],
  [
    "a ref handed to other code",
    "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 })\nuseSync(doubled)",
  ],
  [
    "a once watcher",
    "const first = ref(0)\nwatch(count, (value) => { first.value = value }, { once: true })",
  ],
  [
    "a post-flush effect",
    "const width = ref(0)\nwatchEffect(() => { width.value = count.value * 2 }, { flush: 'post' })",
  ],
  [
    "a sync watcher",
    "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 }, { flush: 'sync' })",
  ],
  [
    "options Doctor cannot see",
    "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 }, options)",
  ],
  [
    "a value unrelated to the source",
    "const stamp = ref(0)\nwatch(count, () => { stamp.value = Date.now() })",
  ],
  [
    "an effect that reads nothing local",
    "const stamp = ref(0)\nwatchEffect(() => { stamp.value = Date.now() })",
  ],
  [
    "a non-ref target",
    "const state = reactive({ doubled: 0 })\nwatch(count, (value) => { state.doubled = value * 2 })",
  ],
  [
    "a ref declared in another scope",
    "const doubled = ref(0)\nfunction start() { watch(count, (value) => { doubled.value = value * 2 }) }",
  ],
  [
    "a compound assignment",
    "const total = ref(0)\nwatch(count, (value) => { total.value += value })",
  ],
])("stays silent for %s", async (_, body) => {
  const result = await runVueSfcRuleFixture(
    preferComputedOverWatchAssign,
    setup(body, "", `${IMPORTS}\nimport { reactive } from 'vue'`),
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["v-model", '<input v-model="doubled">'],
  ["an event handler assignment", '<button @click="doubled = 0">reset</button>'],
  ["a template ref", '<div ref="doubled" />'],
])("stays silent when the template writes the ref through %s", async (_, template) => {
  const result = await runVueSfcRuleFixture(
    preferComputedOverWatchAssign,
    setup(
      "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 })",
      template,
    ),
  );
  expect(result.diagnostics).toEqual([]);
});

test("still reports when the template only binds the ref to a same-name prop", async () => {
  const result = await runVueSfcRuleFixture(
    preferComputedOverWatchAssign,
    setup(
      "const doubled = ref(0)\nwatch(count, (value) => { doubled.value = value * 2 })",
      '<Child :doubled="doubled" @update="(next) => track(next)" />',
    ),
  );
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    preferComputedOverWatchAssign.meta.id,
  ]);
});

test("stays silent for composables that return the ref", async () => {
  const result = await runRuleFixture({
    rule: preferComputedOverWatchAssign,
    framework: "vue",
    files: {
      "src/composables/useDoubled.ts":
        "import { ref, watch } from 'vue'\nexport function useDoubled(count) {\n  const doubled = ref(0)\n  watch(count, (value) => { doubled.value = value * 2 })\n  return { doubled }\n}",
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("ships in the strict preset only", () => {
  const id = preferComputedOverWatchAssign.meta.id;
  expect(vueRulePack.presets.strict).toContain(id);
  expect(vueRulePack.presets.recommended).not.toContain(id);
  expect(vueRulePack.presets.recommended).toContain("vue/attrs/no-watch-use-attrs");
  expect(vueRulePack.presets.recommended).toContain("vue/reactivity/no-reactive-destructure");
});
