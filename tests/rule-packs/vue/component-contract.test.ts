import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { maxProps } from "../../../src/rule-packs/vue/rules/vue/max-props.ts";
import { noUnusedProps } from "../../../src/rule-packs/vue/rules/vue/no-unused-props.ts";
import { runVueSfcRuleFixture } from "../../rule-fixtures.ts";

const MAX_PROPS = "vue/component/max-props";
const UNUSED_PROPS = "vue/props/no-unused-props";

const members = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}: string`).join("; ");

function runMaxProps(files: Record<string, string>, maxPropsOption?: number) {
  return runProjectFixture({
    framework: "vue",
    rules: [maxProps],
    config:
      maxPropsOption === undefined
        ? undefined
        : { rules: { [MAX_PROPS]: ["info", { maxProps: maxPropsOption }] } },
    files,
  });
}

test("both contract rules are strict-only", () => {
  for (const id of [MAX_PROPS, UNUSED_PROPS]) {
    expect(vueRulePack.presets.recommended).not.toContain(id);
    expect(vueRulePack.presets.strict).toContain(id);
  }
});

test("max-props reports an inline type above the default of 12", async () => {
  const result = await runMaxProps({
    "app.vue": `<script setup lang="ts">\ndefineProps<{ ${members("p", 13)} }>()\n</script>`,
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VUE0036"]);
  expect(result.diagnostics[0]!.why).toContain("declares 13 props");
  expect(result.diagnostics[0]!.range?.line).toBe(2);
});

test("max-props stays silent at the default limit", async () => {
  const result = await runMaxProps({
    "app.vue": `<script setup lang="ts">\ndefineProps<{ ${members("p", 12)} }>()\n</script>`,
  });
  expect(result.diagnostics).toEqual([]);
});

test("max-props counts extended local interfaces", async () => {
  const result = await runMaxProps({
    "app.vue": `<script setup lang="ts">
interface Base { ${members("base", 8)} }
interface Props extends Base { ${members("own", 5)} }
withDefaults(defineProps<Props>(), {})
</script>`,
  });
  expect(result.diagnostics[0]?.why).toContain("declares 13 props");
});

test("max-props counts imported and extended types", async () => {
  const result = await runMaxProps({
    "types.ts": `export interface Shared { ${members("shared", 6)} }\nexport type More = { ${members("more", 4)} } & Shared`,
    "app.vue": `<script setup lang="ts">
import type { More } from './types'
interface Props extends More { ${members("own", 3)} }
const { own0 } = defineProps<Props>()
</script>`,
  });
  expect(result.diagnostics[0]?.why).toContain("declares 13 props");
});

test("max-props skips files whose prop type cannot be resolved", async () => {
  const result = await runMaxProps({
    "app.vue": `<script setup lang="ts">
import type { Missing } from './missing'
interface Props extends Missing { ${members("own", 13)} }
defineProps<Props>()
</script>`,
  });
  expect(result.diagnostics).toEqual([]);
});

test("max-props skips runtime declarations it cannot count fully", async () => {
  const props = Array.from({ length: 13 }, (_, index) => `p${index}: String`).join(", ");
  const result = await runMaxProps({
    "spread.vue": `<script setup>\nimport { base } from './base'\ndefineProps({ ...base, ${props} })\n</script>`,
    "shared.vue": `<script setup>\nimport { base } from './base'\ndefineProps(base)\n</script>`,
    "ignored.vue": `<script setup lang="ts">\nimport type { Base } from './base'\ninterface P extends /* @vue-ignore */ Base { ${members("p", 13)} }\ndefineProps<P>()\n</script>`,
  });
  expect(result.diagnostics).toEqual([]);
});

test("max-props counts runtime objects, defineModel and the Options API", async () => {
  const runtime = Array.from({ length: 12 }, (_, index) => `p${index}: String`).join(", ");
  const names = Array.from({ length: 13 }, (_, index) => `'p${index}'`).join(", ");
  const result = await runMaxProps({
    "runtime.vue": `<script setup>\ndefineProps({ ${runtime} })\nconst value = defineModel()\n</script>`,
    "options.vue": `<script>\nexport default { props: [${names}] }\n</script>`,
    "define-component.vue": `<script lang="ts">\nimport { defineComponent } from 'vue'\nexport default defineComponent({ props: { ${runtime}, extra: Number } })\n</script>`,
  });
  expect(
    result.diagnostics
      .map((diagnostic) => diagnostic.file.split("/").at(-1))
      .sort((a, b) => a!.localeCompare(b!)),
  ).toEqual(["define-component.vue", "options.vue", "runtime.vue"]);
});

test("max-props honors a configured maxProps", async () => {
  const files = {
    "app.vue": `<script setup lang="ts">\ndefineProps<{ ${members("p", 5)} }>()\n</script>`,
  };
  expect((await runMaxProps(files, 4)).diagnostics).toHaveLength(1);
  expect((await runMaxProps(files, 5)).diagnostics).toEqual([]);
});

test("max-props points the fix at relaying, responsibilities and slots", async () => {
  const result = await runMaxProps({
    "app.vue": `<script setup lang="ts">\ndefineProps<{ ${members("p", 13)} }>()\n</script>`,
  });
  const fix = JSON.stringify(result.diagnostics[0]);
  expect(fix).toContain("forwarded to a single child");
  expect(fix).toContain("slots");
  expect(fix).toContain("Do not just group unrelated props");
});

test("no-unused-props reports a declared prop the component never reads", async () => {
  const result = await runVueSfcRuleFixture(
    noUnusedProps,
    `<script setup lang="ts">
const props = defineProps<{ title: string; legacySize?: string }>()
</script>
<template><h1>{{ props.title }}</h1></template>`,
  );
  expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.range?.line])).toEqual(
    [["VUE0037", 2]],
  );
  expect(result.diagnostics[0]!.why).toContain('prop "legacySize"');
});

test("no-unused-props sees template, script, style and whole-props reads", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    rules: [noUnusedProps],
    files: {
      "template.vue": `<script setup lang="ts">\ndefineProps<{ title: string }>()\n</script>\n<template><h1>{{ title }}</h1></template>`,
      "ts-template.vue": `<script setup lang="ts">\ndefineProps<{ count: number | string }>()\n</script>\n<template><p>{{ (count as number).toFixed(1) }}</p></template>`,
      "script.vue": `<script setup lang="ts">\nconst { label } = defineProps<{ label: string }>()\nconsole.log(label)\n</script>\n<template><p /></template>`,
      "style.vue": `<script setup lang="ts">\ndefineProps<{ color: string }>()\n</script>\n<template><p /></template>\n<style scoped>p { color: v-bind(color) }</style>`,
      "forwarded.vue": `<script setup lang="ts">\nconst props = defineProps<{ a: string; b: string }>()\nuseThing(props)\n</script>\n<template><p /></template>`,
      "omitted.vue": `<script setup lang="ts">\nimport { reactiveOmit } from '@vueuse/core'\nconst props = withDefaults(defineProps<{ a?: string; class?: string }>(), {})\nconst delegated = reactiveOmit(props, 'class')\n</script>\n<template><Child v-bind="delegated" /></template>`,
      "aliased.vue": `<script setup lang="ts">\nconst props = defineProps<{ a: string }>()\nconst all = props\nuseThing(all)\n</script>\n<template><p /></template>`,
      "template-call.vue": `<script setup lang="ts">\nconst props = defineProps<{ a: string }>()\n</script>\n<template><p>{{ format(props) }}</p></template>`,
      "setup.vue": `<script>\nexport default { props: ['a'], setup(props) { return useThing(props) } }\n</script>\n<template><p /></template>`,
      "bound.vue": `<script setup lang="ts">\ndefineProps<{ a: string; b: string }>()\n</script>\n<template><Child v-bind="$props" /></template>`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("no-unused-props ignores other unused members and non-HTML templates", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    rules: [noUnusedProps],
    config: { rules: { [UNUSED_PROPS]: ["warn", { groups: ["props", "setup", "data"] }] } },
    files: {
      "options.vue": `<script>\nexport default { props: ['title'], data: () => ({ unused: 1 }) }\n</script>\n<template><h1>{{ title }}</h1></template>`,
      "pug.vue": `<script setup lang="ts">\ndefineProps<{ title: string }>()\n</script>\n<template lang="pug">h1 {{ title }}</template>`,
      "external.vue": `<script setup lang="ts">\ndefineProps<{ title: string }>()\n</script>\n<template src="./external.html"></template>`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("no-unused-props skips toRefs(props) when toRefs is auto-imported", async () => {
  const result = await runVueSfcRuleFixture(
    noUnusedProps,
    `<script setup lang="ts">
const props = defineProps<{ a: string; b: string }>()
const { a } = toRefs(props)
console.log(a.value)
</script>
<template><p /></template>`,
  );
  expect(result.diagnostics).toEqual([]);
});

test("no-unused-props still checks props read through an imported toRefs", async () => {
  const result = await runVueSfcRuleFixture(
    noUnusedProps,
    `<script setup lang="ts">
import { toRefs } from 'vue'
const props = defineProps<{ a: string; b: string }>()
const { a } = toRefs(props)
console.log(a.value)
</script>
<template><p /></template>`,
  );
  expect(result.diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
    expect.stringContaining('prop "b"'),
  ]);
});
