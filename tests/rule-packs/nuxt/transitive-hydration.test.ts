import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../../src/core/testkit.ts";
import { noTimeDependentRenderWithoutNuxtTimeOrClientOnly } from "../../../src/rule-packs/nuxt/rules/nuxt/no-time-dependent-render-without-nuxt-time-or-client-only.ts";

test("finds time dependence through local render helpers", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
function label() { return String(clock()) }
const displayed = label()
</script>
<template><span>{{ displayed }}</span></template>`,
  );
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly.meta.id,
  );
});

test("does not report a helper used only by an event handler", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
function click() { console.log(clock()) }
</script>
<template><button @click="click">Check</button></template>`,
  );
  expect(
    result.diagnostics.some(
      (item) => item.ruleId === noTimeDependentRenderWithoutNuxtTimeOrClientOnly.meta.id,
    ),
  ).toBe(false);
});

test.each([':title="label()"', 'v-bind:title="label()"', 'v-if="label()"', 'v-show="label()"'])(
  "finds helper calls in %s",
  async (binding) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup lang="ts">
function clock() { return Date.now() }
const label = () => String(clock())
</script><template><span ${binding}>Label</span></template>`,
    );
    expect(result.diagnostics).toHaveLength(1);
  },
);

test.each([
  "function label(clock) { return clock() }; const displayed = label(() => 'stable')",
  "function label({ clock }) { return clock() }; const displayed = label({ clock: () => 'stable' })",
  "function label() { const clock = () => 'stable'; return clock() }; const displayed = label()",
  "function label() { function clock() { return 'stable' }; return clock() }; const displayed = label()",
  "const displayed = { label: 'stable', refresh: () => clock() }",
  "const displayed = { label: 'stable', refresh() { return clock() } }",
  "const displayed = () => clock()",
  "function label() { if (true) { var clock = () => 'stable' }; return clock() }; const displayed = label()",
  "function label() { for (const clock of [() => 'stable']) { return clock() } }; const displayed = label()",
])("does not connect a shadowed or lazy helper: %s", async (script) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
${script}
</script><template><span>{{ displayed.label }}</span></template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each(['@click="label()"', 'v-on:click="label()"'])(
  "does not treat %s as a rendered value",
  async (binding) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup lang="ts">
function clock() { return Date.now() }
function label() { return clock() }
</script><template><button ${binding}>Refresh</button></template>`,
    );
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each([
  'function label() { clock(); return "Ready" }',
  'function label() { return (clock(), "Ready") }',
  'const label = () => { clock(); return "Ready" }',
  "const label = () => void clock()",
])("does not report discarded helper results: %s", async (script) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
${script}
const displayed = label()
</script><template><span>{{ displayed }}</span></template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});
