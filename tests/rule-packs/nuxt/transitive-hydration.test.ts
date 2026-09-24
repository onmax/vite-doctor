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

test.each([
  "function label() { const value = clock(); return String(value) }",
  "function label() { let value = clock(); return value }",
  'function label() { const value = clock(); { let value = "old"; value = "stable" }; return value }',
  "function label() { const value = clock(); const alias = value; return String(alias) }",
  'function label(value = clock()) { var clock = () => "stable"; return value }',
])("follows returned local bindings: %s", async (script) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
${script}
</script><template><span>{{ label() }}</span></template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each(['v-text="label()"', 'v-html="label()"'])("finds text output in %s", async (binding) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
function label() { return String(clock()) }
</script><template><span ${binding} /></template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each(["item.clock()", "item?.clock()", '"clock()"'])(
  "does not match unrelated template expressions: %s",
  async (expression) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup lang="ts">
function clock() { return Date.now() }
const item = { clock: () => 'stable' }
</script><template><span>{{ ${expression} }}</span></template>`,
    );
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each([
  'function label() { const value = clock(); return "stable" }',
  'function label() { const value = clock(); return (() => { const value = "stable"; return value })() }',
  'function label(value = clock()) { var clock = () => "stable"; return "stable" }',
])("does not follow unused local bindings: %s", async (script) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
${script}
</script><template><span>{{ label() }}</span></template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  `:title="label('short')"`,
  `v-bind:title='label("short")'`,
  `v-for="item in label('short')"`,
  `v-for="(item, index) of label('short')"`,
])("finds render calls with quoted arguments in %s", async (binding) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function label(format) { return Array(Date.now() % 2) }
</script><template><span ${binding}>Label</span></template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  "function* clock() { return Date.now() }",
  "const clock = function* () { return Date.now() }",
  "function clock() { return Date.now() }; function* label() { return clock() }",
])("does not execute generator bodies: %s", async (script) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">${script}</script>
<template><span>{{ ${script.includes("function* label") ? "label()" : "clock()"} }}</span></template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  'let value = clock(); value = "stable"; return value',
  'var value = clock(); value = "stable"; return value',
  'let value = clock(); [value] = ["stable"]; return value',
  'let value = clock(); ({ value } = { value: "stable" }); return value',
  "let value = clock(); value++; return value",
])("does not follow reassigned return aliases: %s", async (body) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
function label() { ${body} }
</script><template><span>{{ label() }}</span></template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});
