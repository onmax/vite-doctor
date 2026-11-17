import { expect, test } from "vite-plus/test";
import { noBrowserGlobalInUniversalCode } from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";

async function reported(files: Record<string, string>) {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files,
  });
  return result.diagnostics.map(
    (item) => `${item.file?.replace(/^.*?\/app\//, "app/")}:${item.range?.line}`,
  );
}

const figure = `export function mountFigure(host: HTMLElement) {
  const fig = document.createElement('div')
  host.append(fig)
  return fig
}
`;

test("a helper called only from onMounted is not reported (vitehub docs hero-figure/engine.ts:213)", async () => {
  expect(
    await reported({
      "app/utils/figure.ts": figure,
      "app/components/Figure.vue": `<script setup lang="ts">
import { mountFigure } from '~/utils/figure'
const host = useTemplateRef<HTMLElement>('host')
onMounted(() => {
  if (host.value) mountFigure(host.value)
})
</script>
<template><div ref="host" /></template>`,
    }),
  ).toEqual([]);
});

test("a helper whose callers Doctor cannot resolve is not reported", async () => {
  expect(
    await reported({
      "app/utils/figure.ts": figure,
      "app/utils/figures.ts": `import { mountFigure } from './figure'
export const figures = { hero: () => mountFigure }
`,
    }),
  ).toEqual([]);
});

test("a helper behind an import.meta.client guard or in a .client component is not reported", async () => {
  expect(
    await reported({
      "app/utils/figure.ts": figure,
      "app/pages/index.vue": `<script setup lang="ts">
import { mountFigure } from '../utils/figure'
if (import.meta.client) mountFigure(document.body)
</script>`,
      "app/components/Mount.client.vue": `<script setup lang="ts">
import { mountFigure } from '~/utils/figure'
mountFigure(document.body)
</script>`,
    }),
  ).toEqual([]);
});

test("a helper called while a page sets up is reported", async () => {
  expect(
    await reported({
      "app/utils/size.ts": `export function readWidth() {
  return window.innerWidth
}
`,
      "app/pages/index.vue": `<script setup lang="ts">
import { readWidth } from '~/utils/size'
const width = readWidth()
</script>
<template><span>{{ width }}</span></template>`,
    }),
  ).toEqual(["app/utils/size.ts:2"]);
});

test("an auto-imported helper called through another helper during setup is reported", async () => {
  expect(
    await reported({
      "app/utils/size.ts": `export const readWidth = () => window.innerWidth
export function describeWidth() {
  return \`\${readWidth()}px\`
}
`,
      "app/composables/useLayout.ts": `export function useLayout() {
  return { label: describeWidth() }
}
`,
    }),
  ).toEqual(["app/utils/size.ts:1"]);
});

test("a browser global in a composable body is still reported", async () => {
  expect(
    await reported({
      "app/composables/useWidth.ts": `export function useWidth() {
  return window.innerWidth
}
`,
    }),
  ).toEqual(["app/composables/useWidth.ts:2"]);
});
