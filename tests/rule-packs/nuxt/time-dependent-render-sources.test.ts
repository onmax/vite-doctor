import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../rule-fixtures.ts";
import { noTimeDependentRenderWithoutNuxtTimeOrClientOnly } from "../../../src/rule-packs/nuxt/rules/nuxt/no-time-dependent-render-without-nuxt-time-or-client-only.ts";

async function reportedLines(source: string) {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    source,
  );
  return result.diagnostics.map((item) => item.range?.line);
}

test.each([
  ["new Date(value.year, value.month - 1, 1)"],
  ["new Date(value)"],
  ["new Date(now.value - 844 * 1_000)"],
])("does not treat Date construction from inputs as time-dependent: %s", async (expression) => {
  const lines = await reportedLines(`<script setup lang="ts">
const value = { year: 2026, month: 10 }
const now = useState("clock", () => 0)
const label = new Intl.DateTimeFormat("en").format(${expression})
</script>
<template><span>{{ label }}</span></template>`);
  expect(lines).toEqual([]);
});

test.each([["new Date()"], ["Date.now()"], ["new Date(Date.now() - 1_000)"]])(
  "still reports current-time reads rendered during SSR: %s",
  async (expression) => {
    const lines = await reportedLines(`<script setup lang="ts">
const label = String(${expression})
</script>
<template><span>{{ label }}</span></template>`);
    expect(lines).toEqual([2]);
  },
);

test("ignores time output rendered only inside ClientOnly", async () => {
  const lines = await reportedLines(`<script setup lang="ts">
const label = String(Date.now())
</script>
<template><ClientOnly><span>{{ label }}</span></ClientOnly></template>`);
  expect(lines).toEqual([]);
});

test("reports time output outside ClientOnly in a file that also uses ClientOnly", async () => {
  const lines = await reportedLines(`<script setup lang="ts">
const clientLabel = String(Date.now())
const label = String(new Date())
</script>
<template>
  <div>
    <ClientOnly><span>{{ clientLabel }}</span></ClientOnly>
    <span>{{ label }}</span>
  </div>
</template>`);
  expect(lines).toEqual([3]);
});

test("reports time output outside NuxtTime in a file that also uses NuxtTime", async () => {
  const lines = await reportedLines(`<script setup lang="ts">
const label = String(Date.now())
</script>
<template>
  <div>
    <NuxtTime :datetime="Date.now()" />
    <span>{{ label }}</span>
  </div>
</template>`);
  expect(lines).toEqual([2]);
});

test("reports time output in a ClientOnly fallback slot rendered during SSR", async () => {
  const lines = await reportedLines(`<script setup lang="ts">
const label = String(Date.now())
</script>
<template><ClientOnly><span>live</span><template #fallback>{{ label }}</template></ClientOnly></template>`);
  expect(lines).toEqual([2]);
});

test.each([
  ['<ClientOnly :fallback="label"><span>live</span></ClientOnly>'],
  ['<ClientOnly :title="label"><span>live</span></ClientOnly>'],
])("reports time output bound on ClientOnly, which SSR renders: %s", async (template) => {
  const lines = await reportedLines(`<script setup lang="ts">
const label = String(Date.now())
</script>
<template>${template}</template>`);
  expect(lines).toEqual([2]);
});
