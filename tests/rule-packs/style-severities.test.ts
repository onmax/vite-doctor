import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noArrayFilterMap } from "../../src/rule-packs/typescript/index.ts";
import { preferPropsDestructureDefaults } from "../../src/rule-packs/vue/rules/vue/index.ts";
import { noBarrelFiles } from "../../src/rule-packs/vite/rules/index.ts";

// Style and micro-performance rules inform; they never decide whether a project is healthy.
test.each([
  [noArrayFilterMap.meta.id, noArrayFilterMap.meta.severity],
  [preferPropsDestructureDefaults.meta.id, preferPropsDestructureDefaults.meta.severity],
  [noBarrelFiles.meta.id, noBarrelFiles.meta.severity],
])("%s reports at info", (_id, severity) => {
  expect(severity).toBe("info");
});

test("TS0012 and VUE0015 diagnostics carry info severity", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: { vue: "^3.5.0" },
    rules: [noArrayFilterMap, preferPropsDestructureDefaults],
    files: {
      "tsconfig.json": "{}",
      "src/values.ts":
        "export const values = [1, 2, 3].filter((value) => value > 1).map((value) => value * 2)",
      "src/Button.vue": `<script setup lang="ts">
const props = withDefaults(defineProps<{ label?: string }>(), { label: 'Save' })
</script>
<template><button>{{ props.label }}</button></template>`,
    },
  });
  expect(result.diagnostics.map((item) => [item.code, item.severity]).sort()).toEqual([
    ["TS0012", "info"],
    ["VUE0015", "info"],
  ]);
});
