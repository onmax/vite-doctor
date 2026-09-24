import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture, runRuleFixture } from "../../../src/core/testkit.ts";
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
  'let value = clock(); if (flag) { value = "stable"; return value }; return "stable"',
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

test.each([
  'let value = clock(); return value; value = "stable"',
  'let value = clock(); function unused() { value = "stable" }; return value',
  'let value = clock(); const unused = () => { value = "stable" }; return value',
  'if (clock() % 2) return "a"; return "b"',
  'switch (clock() % 2) { case 0: return "a"; default: return "b" }',
  'switch (1) { case clock(): return "a"; default: return "b" }',
])("preserves returned time dependence: %s", async (body) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
function label() { ${body} }
</script><template>{{ label() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  '<li v-for="clock in items">{{ clock() }}</li>',
  '<li v-for="{ clock } in items" :title="clock()" />',
  '<Widget v-slot="{ clock }">{{ clock() }}</Widget>',
  '<Widget><template #default="{ clock }">{{ clock() }}</template></Widget>',
  "<!-- {{ clock() }} -->",
  '<!-- <span :title="clock()" /> -->',
])("ignores template-local and commented helper calls: %s", async (template) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
const items = []
</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ["displayed.label", 0],
  ["displayed.generatedAt", 1],
  ["displayed['generatedAt']", 1],
  ["displayed", 1],
])("follows object projections in %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
const displayed = { label: 'stable', generatedAt: clock() }
</script><template>{{ ${expression} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test("follows helper chains beyond four functions and stops cycles", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
function a() { return clock() }
function b() { return a() }
function c() { return b() }
function d() { return c() }
function cycle() { return cycle() + clock() }
</script><template>{{ d() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test("diagnoses byte-identical files independently", async () => {
  const source = `<script setup lang="ts">
function clock() { return Date.now() }
function label() { return clock() }
</script><template>{{ label() }}</template>`;
  const result = await runRuleFixture({
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    framework: "nuxt",
    files: { "app/pages/one.vue": source, "app/pages/two.vue": source },
  });
  expect(result.diagnostics).toHaveLength(2);
});

test("traces typed helpers through the template AST", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock(): number { return Date.now() }
function label(): string { return String(clock()) }
</script><template>{{ label() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["const displayed = computed(() => clock())", "displayed", 1],
  ["const displayed = computed(() => { return clock() })", "displayed", 1],
  ["const displayed = computed(() => { clock(); return 'stable' })", "displayed", 0],
  ["const displayed = ['stable', clock()]", "displayed[0]", 0],
  ["const displayed = ['stable', clock()]", "displayed[1]", 1],
  ["const displayed = { items: ['stable', clock()] }", "displayed.items[0]", 0],
  ["const [displayed] = [clock()]", "displayed", 1],
  ["const [displayed] = ['stable', clock()]", "displayed", 0],
  ["const { time: displayed } = { time: clock() }", "displayed", 1],
  ["const { label: displayed } = { label: 'stable', time: clock() }", "displayed", 0],
])("traces rendered projections: %s -> %s", async (script, expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
${script}
</script><template>{{ ${expression} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  'let value = clock(); if (false) value = "stable"; return value',
  'let value = clock(); if (flag) value = "stable"; return value',
  'let value = clock(); if (flag) { value = "stable"; return "done" }; return value',
  'let value = clock(); flag && (value = "stable"); return value',
  "let value = clock(); for (const item of []) value = item; return value",
])("preserves aliases across conditional writes: %s", async (body) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
function label(flag) { ${body} }
</script><template>{{ label() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each(["[...clock()]", "Array.from(clock())"])(
  "traces consumed generators: %s",
  async (expression) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup lang="ts">
function* clock() { yield Date.now() }
</script><template>{{ ${expression} }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(1);
  },
);

test.each([
  ["function* values() { yield clock() }", "<span>{{ [...values()] }}</span>"],
  ["function* values() { yield clock() }", '<span v-for="value in values()">{{ value }}</span>'],
  [
    "function* values() { yield clock() }; const displayed = [...values()]",
    "<span>{{ displayed }}</span>",
  ],
])("traces helpers through consumed generators: %s", async (script, template) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function clock() { return Date.now() }
${script}
</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["let value; value = clock(); return value", 1],
  ["let value = 'stable'; value = clock(); return value", 1],
  ["let value; value = clock(); value = 'stable'; return value", 0],
  ["let value; value = clock(); return 'stable'", 0],
])("traces later assignments: %s", async (body, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>
function clock() { return Date.now() }
function label() { ${body} }
</script><template>{{ label() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["const displayed = [1].map(() => clock())", 1],
  ["const displayed = [1].flatMap(() => [clock()])", 1],
  ["const displayed = (() => clock())()", 1],
  ["function label() { return [1].map(() => clock()) }; const displayed = label()", 1],
  ["const displayed = [1].map(() => { clock(); return 'stable' })", 0],
  ["const displayed = () => clock()", 0],
  ["const displayed = (() => { [1].map(() => clock()); return 'stable' })()", 0],
  ["const source = [1]; const displayed = source.map(() => clock())", 1],
  ["const source = { map: fn => 'stable' }; const displayed = source.map(() => clock())", 0],
  ["const displayed = setTimeout(() => clock())", 0],
  ["function computed(getter) { return 'stable' }; const displayed = computed(() => clock())", 0],
  ["const computed = getter => 'stable'; const displayed = computed(() => clock())", 0],
  ["import { computed } from 'vue'; const displayed = computed(() => clock())", 1],
])("traces eager callback results: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>
function clock() { return Date.now() }
${script}
</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each(["return Date.now()", "return clock()", "yield 'stable'; return clock()"])(
  "ignores generator completion values: %s",
  async (body) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>
function clock() { return Date.now() }
function* values() { ${body} }
</script><template>{{ [...values()] }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each(["{{ { ...values() } }}", "{{ displayed }}"])(
  "ignores generator object spread: %s",
  async (template) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>
function* values() { yield Date.now() }
const displayed = { ...values() }
</script><template>${template}</template>`,
    );
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each([
  ["const displayed = clock()", '<input v-model="displayed">'],
  ["const displayed = Date.now()", '<input v-model="displayed">'],
])("traces v-model reads: %s", async (script, template) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }; ${script}</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["{ label: 'stable', generatedAt: Date.now() }", "label", 0],
  ["{ label: 'stable', generatedAt: Date.now() }", "generatedAt", 1],
  ["{ label: 'stable', generatedAt: clock() }", "label", 0],
  ["{ label: 'stable', generatedAt: clock() }", "generatedAt", 1],
])("matches template-called helper projections: %s.%s", async (value, property, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }; function details() { return ${value} }</script><template>{{ details().${property} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["let value; [value] = [clock()]; return value", 1],
  ["let value; ({ value } = { value: clock() }); return value", 1],
  ["let value; [value] = ['stable', clock()]; return value", 0],
  ["let value; ({ value } = { value: 'stable', unused: clock() }); return value", 0],
  ["let value; [value] = [clock()]; value = 'stable'; return value", 0],
])("traces destructuring assignments: %s", async (body, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }; function label() { ${body} }; const displayed = label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test("ignores callbacks on replaced array bindings", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }; let source = [1]; source = { map: () => ['stable'] }; const displayed = source.map(() => clock())</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  [
    "function attributeName() { return String(Date.now()) }",
    '<div :[attributeName()]="true" />',
    1,
  ],
  ["const helpers = { label() { return Date.now() } }", "{{ helpers.label() }}", 1],
  [
    "const helpers = { label() { return Date.now() } }; const displayed = helpers.label()",
    "{{ displayed }}",
    1,
  ],
  [
    "const helpers = { label() { return Date.now() }, stable() { return 'stable' } }",
    "{{ helpers.stable() }}",
    0,
  ],
  ["const helpers = { label() { return Date.now() } }", '<button @click="helpers.label()" />', 0],
])("traces dynamic arguments and object helpers: %s", async (script, template, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["helpers = { label: () => 'stable' }", 0],
  ["helpers.label = () => 'stable'", 0],
  ["helpers.other = () => 'stable'", 1],
  ["if (false) helpers.label = () => 'stable'", 1],
])("respects object helper replacement: %s", async (write, count) => {
  for (const templateCall of [false, true]) {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>let helpers = { label() { return Date.now() } }; ${write}; ${templateCall ? "" : "const displayed = helpers.label()"}</script><template>{{ ${templateCall ? "helpers.label()" : "displayed"} }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(count);
  }
});

test.each([
  ["'stable'", 0],
  ["", 1],
  ["undefined", 1],
  ["void 0", 1],
])("evaluates helper defaults only when needed: %s", async (argument, count) => {
  for (const templateCall of [false, true]) {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>function clock() { return Date.now() }; function label(value = clock()) { return value }; ${templateCall ? "" : `const displayed = label(${argument})`}</script><template>{{ ${templateCall ? `label(${argument})` : "displayed"} }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(count);
  }
});

test.each([
  ["[].map(() => clock())", 0],
  ["[...[]].map(() => clock())", 0],
  ["[...[...[]]].map(() => clock())", 0],
  ["[...[], 1].reduce(() => clock())", 0],
  ["[...[,]].map(() => clock())", 1],
  ["[...[1, 2]].reduce(() => clock())", 1],
  ["[, ,].map(() => clock())", 0],
  ["[].find(() => clock())", 0],
  ["[,].find(() => clock())", 1],
  ["[1].reduce(() => clock())", 0],
  ["[, 1].reduceRight(() => clock())", 0],
  ["[1].reduce(() => clock(), 0)", 1],
  ["[1, 2].reduceRight(() => clock())", 1],
  ["[1].map(() => clock())", 1],
])("requires array callbacks to execute: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }; const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["{ value = clock() } = {}", "{ value: 'stable' }", "value", 0],
  ["[value = clock()] = []", "['stable']", "value", 0],
  ["{ nested: { value = clock() } = {} } = {}", "{ nested: { value: 'stable' } }", "value", 0],
  ["{ value = clock() } = { value: 'stable' }", "", "value", 0],
  ["{ nested: { value = clock() } = {} } = {}", "{}", "value", 1],
  ["{ value = clock() } = {}", "{}", "value", 1],
  ["{ value = clock() } = {}", "{ value: undefined }", "value", 1],
  ["{ value = clock() } = {}", "{ value: void 0 }", "value", 1],
  ["{ value = clock() } = {}", "", "value", 1],
  ["{ value = clock() }", "{}", "value", 1],
  ["[value = clock()] = []", "[]", "value", 1],
  ["[value = clock()] = []", "[undefined]", "value", 1],
  ["[value = clock()] = []", "[void 0]", "value", 1],
  ["[value = clock()] = []", "", "value", 1],
  ["{ nested: { value = clock() } = {} } = {}", "{ nested: {} }", "value", 1],
  ["{ value } = { value: clock() }", "{ value: 'stable' }", "value", 0],
  ["[value] = [clock()]", "['stable']", "value", 0],
])(
  "preserves nested parameter defaults: %s with %s",
  async (parameter, argument, returned, count) => {
    for (const templateCall of [false, true]) {
      const result = await runNuxtAppRuleFixture(
        noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
        `<script setup>function clock() { return Date.now() }; function label(${parameter}) { return ${returned} }; ${templateCall ? "" : `const displayed = label(${argument})`}</script><template>{{ ${templateCall ? `label(${argument})` : "displayed"} }}</template>`,
      );
      expect(result.diagnostics).toHaveLength(count);
    }
  },
);

test.each([
  ["", "label()", 0],
  ["const displayed = label()", "displayed", 0],
  ["const displayed = await label()", "displayed", 1],
  ["async function outer() { return await label() }; const displayed = outer()", "displayed", 0],
  [
    "async function outer() { return await label() }; const displayed = await outer()",
    "displayed",
    1,
  ],
])("requires async helper results to be awaited: %s %s", async (script, template, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>async function label() { return Date.now() }; ${script}</script><template>{{ ${template} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  'function label() { Date.now(); return "Ready" }',
  'function label() { const unused = Date.now(); return "Ready" }',
  'const label = () => { Date.now(); return "Ready" }',
])("ignores discarded time values in directly rendered helpers: %s", async (script) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ label() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ["{{ helpers.label }}", ""],
  ['<span :title="helpers.label" />', ""],
  ["{{ displayed }}", "const displayed = helpers.label"],
  ["{{ label() }}", "function label() { return helpers.label }"],
])("finds rendered getter values in %s with %s", async (template, script) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>
const helpers = { get label() { return Date.now() } }
${script}
</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ['get label() { Date.now(); return "Ready" }', "{{ helpers.label }}"],
  ["label() { return Date.now() }", "{{ helpers.label }}"],
  ["get label() { return Date.now() }", '<button @click="helpers.label">Read</button>'],
])("ignores unrendered getter time values: %s", async (property, template) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>const helpers = { ${property} }</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ["await (label())", 1],
  ["await Promise.all([label()])", 1],
  ['(await label(), "stable")', 0],
  ['(await Promise.all([label()]), "stable")', 0],
  ['await (label(), Promise.resolve("stable"))', 0],
])("tracks consumed async results in %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>
async function label() { return Date.now() }
const displayed = ${expression}
</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});
