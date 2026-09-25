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

test.each([
  ["class Clock { read() { return Date.now() } }; const displayed = new Clock().read()", 1],
  ["class Clock { static read() { return Date.now() } }; const displayed = Clock.read()", 1],
  ["class Clock { read() { return Date.now() } }; const displayed = 'stable'", 0],
  [
    "class Clock { read() { return Date.now() }; constructor() { return { read: () => 'stable' } } }; const displayed = new Clock().read()",
    0,
  ],
  [
    "class Clock { read() { return Date.now() } }; Clock.prototype.read = () => 'stable'; const displayed = new Clock().read()",
    0,
  ],
])("traces locally invoked class methods: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
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

test("renders a helper inside a nested template despite a later event binding", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }</script><template><template v-if="true">{{ clock() }}</template><button @click="clock" /></template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["await Promise.all([1].map(async () => Date.now()))", 1],
  ["[1].map(async () => Date.now())", 0],
  ['[1]["map"](() => Date.now())', 1],
])("traces consumed array callback result: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
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
  'let value = clock(); function stabilize() { value = "stable" }; stabilize(); return value',
  'let value = clock(); const stabilize = () => { value = "stable" }; stabilize(); return value',
  'let value = clock(); function stabilize() { value = "stable" }; const run = stabilize; run(); return value',
  'let value = clock(); const helpers = { stabilize() { value = "stable" } }; helpers.stabilize(); return value',
  'let value = clock(); function stabilize() { value = "stable" }; stabilize.call(null); return value',
  'let value = clock(); function stabilize() { value = "stable" }; stabilize.apply(null, []); return value',
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
  'let value = clock(); function stabilize() { value = "stable" }; return value; stabilize()',
  'let value = clock(); function stabilize() { value = "stable" }; if (flag) stabilize(); return value',
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

test.each([
  ["const pending = [clock()]; const displayed = await Promise.all(pending)", 1],
  [
    "const pending = [clock()]; const alias = pending; const displayed = await Promise.all(alias)",
    1,
  ],
  ["let pending = [clock()]; pending = []; const displayed = await Promise.all(pending)", 0],
  ["const pending = [clock()]; const displayed = Promise.all(pending)", 0],
])("tracks collected promise results: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>async function clock() { return Date.now() }; ${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ['clock = () => "stable"', "{{ clock() }}", 0],
  ['clock = () => "stable"; const displayed = clock()', "{{ displayed }}", 0],
  ['const displayed = clock(); clock = () => "stable"', "{{ displayed }}", 1],
  ['if (flag) clock = () => "stable"', "{{ clock() }}", 1],
  ['clock ||= () => "stable"', "{{ clock() }}", 1],
  ['function replace() { clock = () => "stable" }', "{{ clock() }}", 1],
])("tracks standalone helper replacements: %s", async (statements, template, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>let clock = () => Date.now(); ${statements}</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ['const Promise = { all: async () => "stable" };', "Promise.all", 0],
  ['const Promise = { all: () => "stable" };', "Promise.all", 0],
  ["", 'Promise["all"]', 1],
  ['const all = "race";', "Promise[all]", 0],
  ["", "Promise.all", 1],
])("resolves native promise aggregation: %s %s", async (setup, aggregate, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>
async function label() { return Date.now() }
${setup}
const displayed = await ${aggregate}([label()])
</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ['if (Date.now()) return "Ready"; return "Ready"', 0],
  ['if (Date.now()) { return "Ready" } else { return "Ready" }', 0],
  ['if (Date.now()) return "Ready"; return "Waiting"', 1],
  ['if (Date.now()) return "Ready"', 1],
  ['if (Date.now()) return 1; return "1"', 1],
  ['if (Date.now()) return value; return "Ready"', 1],
])("requires conditions to change returned output: %s", async (body, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function label() { ${body} }</script><template>{{ label() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["function clock() { return Date.now() }; const displayed = [1].map(clock)", 1],
  ["const clock = () => Date.now(); const displayed = [1].map(clock)", 1],
  ["function clock() { return Date.now() }; const displayed = [].map(clock)", 0],
  [
    "function clock() { return Date.now() }; function label() { return [1].map(clock) }; const displayed = label()",
    1,
  ],
  [
    'function clock() { return Date.now() }; function label(clock) { return [1].map(clock) }; const displayed = label(() => "stable")',
    0,
  ],
  [
    'function clock() { return Date.now() }; clock = () => "stable"; const displayed = [1].map(clock)',
    0,
  ],
  ["const displayed = [1, 2].sort(() => Date.now() % 2 ? -1 : 1)", 1],
  ["const displayed = [1, 2].toSorted(() => Date.now() % 2 ? -1 : 1)", 1],
  ["const displayed = [1].sort(() => Date.now() % 2 ? -1 : 1)", 0],
  ["const displayed = [].toSorted(() => Date.now() % 2 ? -1 : 1)", 0],
  ["function clock() { return Date.now() % 2 ? -1 : 1 }; const displayed = [1, 2].sort(clock)", 1],
])("traces eager callback bindings: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ['clock = () => "stable"; function clock() { return Date.now() }', "{{ clock() }}", 0],
  [
    'clock = () => "stable"; function clock() { return Date.now() }; const displayed = clock()',
    "{{ displayed }}",
    0,
  ],
  [
    'const displayed = clock(); clock = () => "stable"; function clock() { return Date.now() }',
    "{{ displayed }}",
    1,
  ],
])("honors hoisted helper replacements: %s", async (script, template, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["const Array = { from: () => [] };", "Array.from", 0],
  ["", "Array.from", 1],
  ["", 'Array["from"]', 1],
  ['const from = "of";', "Array[from]", 0],
])("resolves native iterator consumption: %s %s", async (setup, consume, count) => {
  for (const templateCall of [false, true]) {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>function* clock() { yield Date.now() }; ${setup}
      ${templateCall ? "" : `const displayed = ${consume}(clock())`}</script>
      <template>{{ ${templateCall ? `${consume}(clock())` : "displayed"} }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(count);
  }
});

test.each(['status = "Ready"', "update()", "const ignored = update()"])(
  "preserves conditionally selected effects: %s",
  async (effect) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>
let status = "Waiting";
function update() { status = "Ready" }
function label() { if (Date.now()) { ${effect}; return "Label" } return "Label" }
</script><template>{{ label() }} {{ status }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(1);
  },
);

test.each([
  ["const displayed = details()", "displayed.label", 0],
  ["const displayed = details()", "displayed.generatedAt", 1],
  ["let displayed; displayed = details()", "displayed.label", 0],
  ["let displayed; displayed = details()", "displayed.generatedAt", 1],
  ["const { label: displayed } = details()", "displayed", 0],
  ["const { generatedAt: displayed } = details()", "displayed", 1],
])("preserves returned projections: %s %s", async (assignment, rendered, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function details() { return { label: 'stable', generatedAt: Date.now() } }
    ${assignment}</script><template>{{ ${rendered} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["let displayed; displayed = clock()", "{{ displayed }}", 1],
  ["", '<button @click="clock">{{ clock() }}</button>', 1],
  ["const displayed = clock()", '<button @click="clock">{{ displayed }}</button>', 1],
  ["", '<button @click="clock">Stable</button>', 0],
  ["", '<button v-on:click="clock">{{ clock() }}</button>', 1],
  ["const displayed = clock()", '<button v-on:click.prevent="clock">{{ displayed }}</button>', 1],
  ["", '<button v-on:click="clock">Stable</button>', 0],
])("traces assigned and event-shared helpers: %s %s", async (setup, template, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }; ${setup}</script><template>${template}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each(["0", "const ignored = 1 + 1", "void 0", "const ignored = true ? 1 : 2"])(
  "ignores inert statements in equal-return helpers: %s",
  async (statement) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>function label() { if (Date.now()) { ${statement}; return 'Label' } return 'Label' }</script><template>{{ label() }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(0);
  },
);

test("preserves client guards in helpers shared with event bindings", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { if (import.meta.client) return Date.now(); return 'stable' }</script>
    <template><button @click="clock">{{ clock() }}</button></template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ["await (async () => Date.now())()", 1],
  ["(async () => Date.now())()", 0],
  ["await Promise.all([(async () => Date.now())()])", 1],
  ["Promise.all([(async () => Date.now())()])", 0],
  ["await (async () => { Date.now(); return 'stable' })()", 0],
])("traces consumed async IIFEs: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["[1] as const", 1],
  ["([1] satisfies number[])", 1],
  ["([1] as number[])!", 1],
  ["[] as const", 0],
])("traces typed array callback receivers: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">const source = ${expression}; const displayed = source.map(() => Date.now())</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["await ((async () => Date.now()) as () => Promise<number>)()", 1],
  ["await ((async () => Date.now())() satisfies Promise<number>)", 1],
  ["((async () => Date.now())() satisfies Promise<number>)", 0],
])("traces typed async IIFEs: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["let clock; clock = () => Date.now(); const displayed = clock()", 1],
  ["let clock = () => 'stable'; clock = () => Date.now(); const displayed = clock()", 1],
  ["let clock = () => 'stable'; const displayed = clock(); clock = () => Date.now()", 0],
  ["let clock = () => 'stable'; if (false) clock = () => Date.now(); const displayed = clock()", 0],
  ["let clock; clock = function () { return Date.now() }; const displayed = clock()", 1],
  ["let clock; clock = () => Date.now(); clock = () => 'stable'; const displayed = clock()", 0],
  ["function clock() { return Date.now() }; const now = clock; const displayed = now()", 1],
  [
    "function clock() { return Date.now() }; const now = clock; const alias = now; const displayed = alias()",
    1,
  ],
  [
    "function clock() { return Date.now() }; let now = clock; now = () => 'stable'; const displayed = now()",
    0,
  ],
  [
    "function clock() { return Date.now() }; const now = clock; function label(now) { return now() }; const displayed = label(() => 'stable')",
    0,
  ],
])("traces assigned and aliased helpers: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["helpers.details.generatedAt", 1],
  ["helpers.details.label", 0],
])("projects rendered getter objects: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>const helpers = { get details() { return { generatedAt: Date.now(), label: 'stable' } } }</script><template>{{ ${expression} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["const now = clock", 1],
  ["let now = clock; now = () => 'stable'", 0],
])("traces template helper aliases: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }; ${script}</script><template>{{ now() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  [
    "async function clock() { return Date.now() }; async function label() { return clock() }; const displayed = await label()",
    "displayed",
    1,
  ],
  [
    "async function clock() { return Date.now() }; async function label() { return clock() }; const displayed = label()",
    "displayed",
    0,
  ],
  [
    "const helpers = { label() { return Date.now() } }; const label = helpers.label; const displayed = label()",
    "displayed",
    1,
  ],
  ["const helpers = { label() { return Date.now() } }; const label = helpers.label", "label()", 1],
  ["const displayed = Array.from([1], () => Date.now())", "displayed", 1],
  ["const displayed = Array.from([], () => Date.now())", "displayed", 0],
  ["const displayed = Array.from('x', () => Date.now())", "displayed", 1],
  ["const displayed = Array.from('', () => Date.now())", "displayed", 0],
  ["const displayed = Array.from({ length: 1 }, () => Date.now())", "displayed", 1],
  ["const displayed = Array.from({ length: 0 }, () => Date.now())", "displayed", 0],
  ["const displayed = Array.from({ length: '1' }, () => Date.now())", "displayed", 1],
  ["const displayed = Array.from({ length: true }, () => Date.now())", "displayed", 1],
  ["const displayed = Array.from({ length: 0.5 }, () => Date.now())", "displayed", 0],
  ["const displayed = Array.from({ length: '0' }, () => Date.now())", "displayed", 0],
  ["const displayed = Array.from({ length: false }, () => Date.now())", "displayed", 0],
  [
    "const Array = { from: () => [] }; const displayed = Array.from([1], () => Date.now())",
    "displayed",
    0,
  ],
  [
    "function clock() { return Date.now() }; const displayed = Array.from([1], clock)",
    "displayed",
    1,
  ],
  [
    "let clock; clock = () => Date.now(); const now = clock; clock = () => 'stable'; const displayed = now()",
    "displayed",
    1,
  ],
  ["let clock; clock = () => Date.now(); const now = clock; clock = () => 'stable'", "now()", 1],
  ["let clock; clock = () => Date.now(); clock = () => 'stable'; const now = clock", "now()", 0],
  ["let clock; const now = clock; clock = () => Date.now()", "now()", 0],
  [
    "const helpers = { get details() { return { generatedAt: Date.now(), label: 'stable' } } }; const details = helpers.details; const view = details; const alias = view",
    "alias.generatedAt",
    1,
  ],
  [
    "const helpers = { get details() { return { generatedAt: Date.now(), label: 'stable' } } }; const details = helpers.details; const view = details",
    "view.label",
    0,
  ],
])("preserves reviewed hydration flow: %s rendered as %s", async (script, expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ ${expression} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["await Promise.race([clock()])", 1],
  ["await Promise.any([clock()])", 1],
  ["await Promise.allSettled([clock()])", 1],
  ["Promise.race([clock()])", 0],
  ["await Promise['race']([clock()])", 1],
])("tracks native async aggregation: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>async function clock() { return Date.now() }
const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["yield* clock()", "[...outer()]", 1],
  ["yield clock()", "[...outer()]", 0],
  ["yield* clock()", "outer()", 0],
])("tracks delegated generators: %s %s", async (body, expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function* clock() { yield Date.now() }
function* outer() { ${body} }
const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each(["findLast", "findLastIndex"])("tracks eager %s callbacks", async (method) => {
  for (const [array, count] of [
    ["[1]", 1],
    ["[,]", 1],
    ["[]", 0],
  ] as const) {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>const displayed = ${array}.${method}(() => Date.now() % 2)</script><template>{{ displayed }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(count);
  }
});

test.each([
  ["try { return clock() } finally { return 'stable' }", 0],
  ["try { return await clock() } finally { return 'stable' }", 0],
  ["try { return clock() } finally { if (flag) return 'stable' }", 1],
  ["try { return clock() } finally { if (flag) return 'a'; else return 'b' }", 0],
  ["try { return clock() } finally { console.log('done') }", 1],
  ["try { return 'stable' } finally { return clock() }", 1],
  ["try { return clock() } finally { throw new Error('failed') }", 0],
  ["try { return clock() } finally { function unused() { return 'stable' } }", 1],
])("respects finally completion: %s", async (body, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>async function clock() { return Date.now() }
async function label() { ${body} }
const displayed = await label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  [
    "async function clock() { return Date.now() }; const displayed = await clock().then(value => value)",
    1,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await clock().then(value => 'Ready')",
    0,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await clock().finally(() => 'Ready')",
    1,
  ],
  ["function* clock() { yield Date.now() }; const [displayed] = clock()", 1],
  ["function* clock() { yield Date.now() }; let displayed; [displayed] = clock()", 1],
  ["function label() { return true ? 'Ready' : Date.now() }; const displayed = label()", 0],
  ["function label() { return false && Date.now() }; const displayed = label()", 0],
  ["function label() { return 'Ready' || Date.now() }; const displayed = label()", 0],
  ["function label() { return 'Ready' ?? Date.now() }; const displayed = label()", 0],
  ["function label() { return false ? 'Ready' : Date.now() }; const displayed = label()", 1],
  ["function label() { return true && Date.now() }; const displayed = label()", 1],
  ["function label() { return null ?? Date.now() }; const displayed = label()", 1],
  [
    "function clock() { return Date.now() }; function stable(value) { return 'Ready' }; function label() { return stable(clock()) }; const displayed = label()",
    0,
  ],
  [
    "function clock() { return Date.now() }; function identity(value) { return value }; function label() { return identity(clock()) }; const displayed = label()",
    1,
  ],
  [
    "function clock() { return Date.now() }; const stable = value => 'Ready'; function label() { return stable(clock()) }; const displayed = label()",
    0,
  ],
])("respects reviewed result consumption: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["while (true) { try { return clock() } finally { break } } return 'stable'", 0],
  [
    "for (let i = 0; i < 1; i++) { try { return clock() } finally { continue } } return 'stable'",
    0,
  ],
  ["outer: while (true) { try { return clock() } finally { break outer } } return 'stable'", 0],
  [
    "outer: for (let i = 0; i < 1; i++) { try { return clock() } finally { continue outer } } return 'stable'",
    0,
  ],
  ["try { return clock() } finally { while (true) { break } }", 1],
  ["try { return clock() } finally { for (let i = 0; i < 1; i++) { continue } }", 1],
  ["try { return clock() } finally { inner: { break inner } }", 1],
  ["while (true) { try { return clock() } finally { if (flag) break } } return 'stable'", 1],
])("respects finally loop control: %s", async (body, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>async function clock() { return Date.now() }
async function label() { ${body} }
const displayed = await label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  [
    "async function clock() { return Date.now() }; const pending = clock(); const displayed = await pending",
    1,
  ],
  [
    "async function clock() { return Date.now() }; const pending = clock(); const alias = pending; const displayed = await alias",
    1,
  ],
  [
    "async function clock() { return Date.now() }; let pending = clock(); pending = Promise.resolve('stable'); const displayed = await pending",
    0,
  ],
  [
    "async function clock() { return Date.now() }; const pending = clock(); const displayed = pending",
    0,
  ],
  [
    "async function clock() { return Date.now() }; async function label() { const pending = clock(); return await pending }; const displayed = await label()",
    1,
  ],
  [
    "function clock() { return Date.now() }; function select(value) { return value.label }; function label() { return select({ label: 'Ready', generatedAt: clock() }) }; const displayed = label()",
    0,
  ],
  [
    "function clock() { return Date.now() }; function select(value) { return value.generatedAt }; function label() { return select({ label: 'Ready', generatedAt: clock() }) }; const displayed = label()",
    1,
  ],
  [
    "const source = [1]; source.map = () => ['stable']; const displayed = source.map(() => Date.now())",
    0,
  ],
  [
    "const source = [1]; source['map'] = () => ['stable']; const displayed = source.map(() => Date.now())",
    0,
  ],
  [
    "const source = [1]; source.filter = () => ['stable']; const displayed = source.map(() => Date.now())",
    1,
  ],
  ["function clock<T>() { return Date.now() }; const displayed = (clock<number>)()", 1],
  [
    "function clock<T>() { return Date.now() }; const alias = clock<number>; const displayed = alias()",
    1,
  ],
])("respects reviewed aliases and projections: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["function identity(value) { return value }", "identity", 1],
  ["const identity = (value) => value; const alias = identity", "alias", 1],
  ["function stable(value) { return 'stable' }", "stable", 0],
  ["let identity = (value) => value; identity = () => 'stable'", "identity", 0],
])("traces local promise callbacks: %s", async (declaration, callback, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>async function clock() { return Date.now() }; ${declaration}; const displayed = await clock().then(${callback})</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["async function clock() { return Date.now() }; let displayed; displayed = await clock()", 1],
  ["const source = [1]; const alias = source; const displayed = alias.map(() => Date.now())", 1],
  ["const source = []; const alias = source; const displayed = alias.map(() => Date.now())", 0],
  [
    "let source = [1]; source = []; const alias = source; const displayed = alias.map(() => Date.now())",
    0,
  ],
  [
    "const source = [1]; const alias = source; source.map = () => []; const displayed = alias.map(() => Date.now())",
    0,
  ],
  [
    "function label() { const result = {}; result.generatedAt = Date.now(); return result.generatedAt }; const displayed = label()",
    1,
  ],
  [
    "function label() { const result = {}; result.generatedAt = Date.now(); return result.label }; const displayed = label()",
    0,
  ],
  [
    "async function clock() { return Date.now() }; const pending = clock(); let displayed = await pending; displayed = 'stable'",
    0,
  ],
  [
    "async function clock() { return Date.now() }; const pending = clock(); let displayed = await pending; if (flag) displayed = 'stable'",
    1,
  ],
  [
    "async function clock() { return Date.now() }; const pending = clock(); let displayed = await pending; function event() { displayed = 'stable' }",
    1,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await clock().then(value => { value = 'stable'; return value })",
    0,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await clock().then(value => { if (flag) value = 'stable'; return value })",
    1,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await clock().then(value => { return value; value = 'stable' })",
    1,
  ],
  [
    "async function clock() { return Date.now() }; const pending = clock(); let displayed; displayed = await pending",
    1,
  ],
  [
    "async function clock() { return Date.now() }; let displayed = await clock(); displayed = 'stable'",
    0,
  ],
  [
    "const source = [1]; const alias = source; const next = alias; const displayed = next.map(() => Date.now())",
    1,
  ],
  [
    "const source = [1]; const alias = source; alias.map = () => []; const displayed = alias.map(() => Date.now())",
    0,
  ],
  [
    "function label() { const result = { nested: {} }; result.nested.generatedAt = Date.now(); return result.nested.generatedAt }; const displayed = label()",
    1,
  ],
  [
    "function label() { const result = {}; result['generatedAt'] = Date.now(); return result.generatedAt }; const displayed = label()",
    1,
  ],
])("respects reviewed value writes and member flow: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["result.generatedAt = 'stable'", 0],
  ["result['generatedAt'] = 'stable'", 0],
  ["result = { generatedAt: 'stable' }", 0],
  ["result.label = 'stable'", 1],
  ["if (flag) result.generatedAt = 'stable'", 1],
  ["function event() { result.generatedAt = 'stable' }", 1],
])("respects stored member replacements: %s", async (replacement, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function label() { let result = {}; result.generatedAt = Date.now(); ${replacement}; return result.generatedAt }; const displayed = label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["result.nested.generatedAt = 'stable'", 0],
  ["result['nested'] = { generatedAt: 'stable' }", 0],
  ["result.nested.label = 'stable'", 1],
  ["if (flag) result.nested = {}", 1],
])("respects nested stored member replacements: %s", async (replacement, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function label() { const result = { nested: {} }; result.nested.generatedAt = Date.now(); ${replacement}; return result.nested.generatedAt }; const displayed = label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test("preserves stored member flow before a later replacement", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function label() { const result = {}; result.generatedAt = Date.now(); return result.generatedAt; result.generatedAt = 'stable' }; const displayed = label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["const alias = result; alias.generatedAt = 'stable'", 0],
  ["const alias = result; const next = alias; next.generatedAt = 'stable'", 0],
  ["const alias = result; alias['generatedAt'] = 'stable'", 0],
  ["const alias = result; alias.label = 'stable'", 1],
  ["const alias = result; if (flag) alias.generatedAt = 'stable'", 1],
  ["const alias = result; function event() { alias.generatedAt = 'stable' }", 1],
  ["let alias = result; alias = {}; alias.generatedAt = 'stable'", 1],
  ["let alias = result; const next = alias; alias = {}; next.generatedAt = 'stable'", 0],
])("respects stored member replacements through object aliases: %s", async (replacement, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function label() { const result = {}; result.generatedAt = Date.now(); ${replacement}; return result.generatedAt }; const displayed = label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test("preserves stored member flow when an alias captured a replaced object", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function label() { let result = {}; const alias = result; result = {}; result.generatedAt = Date.now(); alias.generatedAt = 'stable'; return result.generatedAt }; const displayed = label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["label", 0],
  ["generatedAt", 1],
  ["length", 0],
])("preserves eager callback result projection %s", async (property, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>const displayed = [1].map(() => ({ label: 'stable', generatedAt: Date.now() }))</script>
<template>{{ displayed[0].${property} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test("does not project mapped values into the array length", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>const displayed = [1].map(() => Date.now())</script><template>{{ displayed.length }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  "const { clock } = helpers",
  "const { clock: now } = helpers; const clock = now",
  "const { ['clock']: clock } = helpers",
])("resolves destructured helper methods: %s", async (declaration) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>const helpers = { clock() { return Date.now() } }; ${declaration}</script>
<template>{{ clock() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["'Ready'", 0],
  ["value", 1],
])("tracks arguments consumed by local object methods returning %s", async (returned, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>
function clock() { return Date.now() }
const helpers = { stable(value) { return ${returned} } }
function label() { return helpers.stable(clock()) }
const displayed = label()
</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test("does not use a replaced object method to discard hydration flow", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>
function clock() { return Date.now() }
const helpers = { stable(value) { return 'Ready' } }
helpers.stable = value => value
function label() { return helpers.stable(clock()) }
const displayed = label()
</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["helpers.label = 'changed'", 0],
  ["helpers['label'] = 'changed'", 0],
  ["helpers.nested.label = 'changed'", 0],
  ["helpers.nested.stable = value => value", 1],
  ["helpers.nested = { stable: value => value }", 1],
  ["helpers.nested[key] = value => value", 1],
])("isolates local method replacements from sibling writes: %s", async (write, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>
function clock() { return Date.now() }
const helpers = { nested: { stable(value) { return 'Ready' } } }
${write}
function label() { return helpers.nested.stable(clock()) }
const displayed = label()
</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each(["@update:model-value", "v-on:custom-event"])(
  "preserves SSR calls shared with %s",
  async (event) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>function clock() { return Date.now() }</script>
<template><Widget ${event}="clock">{{ clock() }}</Widget></template>`,
    );
    expect(result.diagnostics).toHaveLength(1);
  },
);

test.each([
  ["Promise.resolve(clock())", "displayed", 1],
  ["Promise.allSettled([clock()])", "displayed[0].status", 0],
  ["Promise.allSettled([clock()])", "displayed[0].value", 1],
])("tracks adopted async output %s rendered as %s", async (expression, rendered, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>async function clock() { return Date.now() }
const displayed = await ${expression}</script><template>{{ ${rendered} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each(["return", "return undefined"])(
  "treats identical %s results as stable",
  async (returned) => {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>function label() { if (Date.now()) ${returned}; return }</script>
<template>{{ label() }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(0);
  },
);

test("does not adopt output through a shadowed Promise.resolve", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>async function clock() { return Date.now() }
const Promise = { resolve(value) { return 'stable' } }
const displayed = await Promise.resolve(clock())</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});

test("does not normalize a shadowed undefined return", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function label(undefined = 'unstable') { if (Date.now()) return undefined; return }</script>
<template>{{ label() }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["let alias = result; if (flag) alias = {}; const next = alias; next.generatedAt = 'stable'", 1],
  ["let alias = result; const next = alias; if (flag) alias = {}; next.generatedAt = 'stable'", 0],
])("preserves conditional alias identity: %s", async (replacement, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function label() { const result = {}; result.generatedAt = Date.now(); ${replacement}; return result.generatedAt }; const displayed = label()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});
test.each([
  [
    "const undefined = 'stable'; function label(value = Date.now()) { return value }; const displayed = label(undefined)",
    0,
  ],
  ["function label(value = Date.now()) { return value }; const displayed = label(undefined)", 1],
])("resolves undefined default arguments: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["const helpers = { clock }", "helpers.clock()", 1],
  ["const helpers = { clock }; clock = () => 'stable'", "helpers.clock()", 1],
  ["const helpers = { nested: { clock } }", "helpers.nested.clock()", 1],
  ["const helpers = { clock }; helpers.clock = () => 'stable'", "helpers.clock()", 0],
  ["const helpers = { clock }; helpers.status = 'ready'", "helpers.clock()", 1],
])("traces helpers stored as object values: %s", async (script, expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock() { return Date.now() }; ${script}</script><template>{{ ${expression} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["clock().next().value", 1],
  ["clock().next().done", 0],
  ["clock().next", 0],
])("recognizes direct generator advancement: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function* clock() { yield Date.now() }; const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["let displayed; function initialize() { displayed = Date.now() }; initialize()", 1],
  [
    "let displayed; function initialize() { displayed = Date.now() }; function setup() { initialize() }; setup()",
    1,
  ],
  ["let displayed; function initialize() { displayed = Date.now() }", 0],
  ["let displayed; function initialize() { displayed = Date.now() }; onMounted(initialize)", 0],
  [
    "let displayed; function initialize() { displayed = Date.now() }; initialize(); displayed = 'stable'",
    0,
  ],
  [
    "let displayed; function initialize() { let displayed; displayed = Date.now() }; initialize()",
    0,
  ],
  [
    "let displayed; function stable(value) { return 'ready' }; function initialize() { displayed = stable(Date.now()) }; initialize()",
    0,
  ],
])("traces setup helper writes to rendered bindings: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test("ignores a setup write replaced within the helper", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>let displayed; function initialize() { displayed = Date.now(); displayed = 'stable' }; initialize()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(0);
});
test("traces generator advancement in the template", async () => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function* clock() { yield Date.now() }</script><template>{{ clock().next().value }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["if (false) initialize()", 0],
  ["false && initialize()", 0],
  ["true || initialize()", 0],
  ["true ? null : initialize()", 0],
  ["function setup() { if (false) initialize() }; setup()", 0],
  ["function setup() { initialize() }; if (false) setup()", 0],
  ["if (true) initialize()", 1],
  ["if (flag) initialize()", 1],
])("respects setup call reachability: %s", async (calls, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>let displayed; function initialize() { displayed = Date.now() }; ${calls}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["yield 'stable'; yield Date.now()", 0],
  ["yield Date.now(); yield 'stable'", 1],
  ["if (false) yield 'stable'; yield Date.now()", 1],
  ["if (true) yield 'stable'; yield Date.now()", 0],
  ["const time = Date.now(); yield 'stable'; yield time", 0],
  ["const time = Date.now(); yield time; yield 'stable'", 1],
  ["if (flag) yield 'stable'; yield Date.now()", 1],
])("attributes the first generator advancement: %s", async (body, count) => {
  for (const template of [false, true]) {
    const result = await runNuxtAppRuleFixture(
      noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
      `<script setup>function* clock() { ${body} }; ${template ? "" : "const displayed = clock().next().value"}</script><template>{{ ${template ? "clock().next().value" : "displayed"} }}</template>`,
    );
    expect(result.diagnostics).toHaveLength(count);
  }
});

test.each([
  ["clock.call(null)", "return Date.now()", "displayed", 1],
  ["clock.apply(null, [])", "return Date.now()", "displayed", 1],
  ["clock.call(null, 'stable')", "return value", "displayed", 0],
  ["clock.apply(null, ['stable'])", "return value", "displayed", 0],
  ["clock.call(null)", "return value", "displayed", 1],
  ["clock.apply(null, [])", "return value", "displayed", 1],
  ["new clock()", "return { generatedAt: Date.now() }", "displayed.generatedAt", 1],
  ["new clock()", "return Date.now()", "displayed", 0],
])("traces local invocation results: %s / %s", async (call, body, rendered, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock(value = Date.now()) { ${body} }; const displayed = ${call}</script><template>{{ ${rendered} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["const helpers = { call(value = Date.now()) { return value } }", "helpers.call('stable')", 0],
  ["function clock() { return Date.now() }", "clock.call(null)", 1],
  ["function clock() { return Date.now() }", "clock.apply(null, [])", 1],
  ["const helpers = { clock() { return Date.now() } }", "helpers.clock.call(null)", 1],
])("traces template helper invocations: %s / %s", async (script, expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ ${expression} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["[1].forEach(() => { displayed = Date.now() })", 1],
  ["[].forEach(() => { displayed = Date.now() })", 0],
  ["computed(() => { displayed = Date.now() })", 0],
  ["[1].forEach(() => Date.now())", 0],
  ["if (false) [1].forEach(() => { displayed = Date.now() })", 0],
  ["function initialize() { displayed = Date.now() }; [1].forEach(initialize)", 1],
  ["function setup() { [1].forEach(() => { displayed = Date.now() }) }; setup()", 1],
  ["[1].forEach(() => { displayed = Date.now() }); displayed = 'stable'", 0],
])("traces eager callback writes: %s", async (calls, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>let displayed; ${calls}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["yield Date.now(); yield 'stable'", "[, displayed]", 0],
  ["yield Date.now(); yield 'stable'", "[displayed]", 1],
  ["yield 'stable'; yield Date.now()", "[, displayed]", 1],
  ["yield 'stable'; yield Date.now()", "[displayed]", 0],
  ["const time = Date.now(); yield time; yield 'stable'", "[, displayed]", 0],
  ["const time = Date.now(); yield 'stable'; yield time", "[, displayed]", 1],
])("projects generator destructuring: %s / %s", async (body, pattern, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function* values() { ${body} }; const ${pattern} = values()</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["function clock() {}; clock.call = (value = Date.now()) => value", "clock.call('stable')", 0],
  ["function clock() {}; clock.apply = (value = Date.now()) => value", "clock.apply('stable')", 0],
  ["function clock() {}; clock.call = (value = Date.now()) => value", "clock.call()", 1],
  [
    "function clock(value = Date.now()) { return value }; clock.call = () => 'stable'",
    "clock.call(null)",
    0,
  ],
  [
    "function clock(value = Date.now()) { return value }; clock.apply = () => 'stable'",
    "clock.apply(null, [])",
    0,
  ],
  ["function clock() { return 'stable' }; clock.call = () => Date.now()", "clock.call(null)", 1],
  [
    "function* stable() { yield 'stable' }; function* clock() { yield* stable(); yield Date.now() }",
    "clock().next().value",
    0,
  ],
  [
    "function* stable() {}; function* clock() { yield* stable(); yield Date.now() }",
    "clock().next().value",
    1,
  ],
  [
    "function* inner() { yield Date.now() }; function* clock() { yield* inner(); yield 'stable' }",
    "clock().next().value",
    1,
  ],
])(
  "preserves invocation identity and delegated advancement: %s",
  async (script, expression, count) => {
    for (const template of [false, true]) {
      const result = await runNuxtAppRuleFixture(
        noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
        `<script setup>${script}; ${template ? "" : `const displayed = ${expression}`}</script><template>{{ ${template ? expression : "displayed"} }}</template>`,
      );
      expect(result.diagnostics).toHaveLength(count);
    }
  },
);

test.each([
  [
    "function clock() { return Date.now() }; let displayed = 'stable'; if (false) displayed = clock()",
    0,
  ],
  ["let displayed; async function initialize() { displayed = Date.now() }; await initialize()", 1],
  [
    "let displayed; async function initialize() { await later(); displayed = Date.now() }; await initialize()",
    1,
  ],
  [
    "let displayed; async function initialize() { await later(); displayed = Date.now() }; initialize()",
    0,
  ],
  ["let displayed; [1].forEach(async () => { displayed = Date.now(); await later() })", 1],
  ["let displayed; [1].forEach(async () => { await later(); displayed = Date.now() })", 0],
  [
    "function clock() { return Date.now() }; function makeClock() { return () => clock() }; const displayed = makeClock()()",
    1,
  ],
  [
    "function clock() { return Date.now() }; function makeClock() { return () => clock() }; const displayed = makeClock()",
    0,
  ],
  [
    "function* values() { yield 'stable'; if (flag) yield Date.now() }; const [displayed] = values()",
    0,
  ],
  [
    "function* values() { yield 'stable'; if (flag) yield Date.now() }; const [, displayed] = values()",
    1,
  ],
])("preserves reviewed execution and slot reachability: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  [
    "async function clock() { return Date.now() }; const displayed = await clock().then(value => ({ label: 'Ready', generatedAt: value }))",
    "displayed.label",
    0,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await clock().then(value => ({ label: 'Ready', generatedAt: value }))",
    "displayed.generatedAt",
    1,
  ],
  [
    "let displayed = 'stable'; function initialize() { if (false) displayed = Date.now() }; initialize()",
    "displayed",
    0,
  ],
  [
    "function clock(value = Date.now()) { return value }; const alias = clock; alias.call = () => 'stable'; const displayed = clock.call(null)",
    "displayed",
    0,
  ],
  [
    "function clock(value = Date.now()) { return value }; const alias = () => 'other'; alias.call = () => 'stable'; const displayed = clock.call(null)",
    "displayed",
    1,
  ],
  [
    "let displayed = 'stable'; async function initialize(flag) { if (flag) await later(); displayed = Date.now() }; initialize(false)",
    "displayed",
    1,
  ],
  [
    "let displayed = 'stable'; async function initialize() { await later(); displayed = Date.now() }; await Promise.all([initialize()])",
    "displayed",
    1,
  ],
  [
    "let displayed = 'stable'; async function initialize(flag) { if (flag) await later(); displayed = Date.now() }; initialize(true)",
    "displayed",
    0,
  ],
  [
    "let displayed = 'stable'; async function initialize() { await later(); displayed = Date.now() }; await Promise.resolve(initialize())",
    "displayed",
    1,
  ],
  [
    "let displayed = 'stable'; async function initialize() { await later(); displayed = Date.now() }; Promise.all([initialize()])",
    "displayed",
    0,
  ],
  [
    "function* values() { if (flag) yield Date.now() }; const [, displayed] = values()",
    "displayed",
    0,
  ],
  [
    "function* values() { if (flag) yield Date.now() }; const [displayed] = values()",
    "displayed",
    1,
  ],
  [
    "function* stable() { if (flag) yield 'a'; else yield 'b' }; function* values() { yield* stable(); yield Date.now() }; const displayed = values().next().value",
    "displayed",
    0,
  ],
])("preserves reviewed execution flow: %s (%s)", async (script, rendered, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">${script}</script><template>{{ ${rendered} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["value => value", "displayed.label", 0],
  ["value => value", "displayed.generatedAt", 1],
  ["value => ({ nested: value })", "displayed.nested.label", 0],
  ["value => ({ nested: value })", "displayed.nested.generatedAt", 1],
  ["value => value.label", "displayed", 0],
  ["value => value.generatedAt", "displayed", 1],
])("preserves incoming Promise projections: %s", async (callback, rendered, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
async function clock() { return { label: 'Ready', generatedAt: Date.now() } }
const displayed = await clock().then(${callback})
</script><template>{{ ${rendered} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["[, displayed]", 0],
  ["[, , displayed]", 1],
  ["[, , , displayed]", 0],
])("bounds delegated generator slots: %s", async (pattern, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">
function* values() { yield* ['a', 'b']; yield Date.now() }
const ${pattern} = values()
</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  [
    "const source = []; const alias = source; alias.push(1); const displayed = source.map(() => Date.now())",
    1,
  ],
  ["const source = [1]; source.pop(); const displayed = source.map(() => Date.now())", 0],
  [
    "const source = []; if (false) source.push(1); const displayed = source.map(() => Date.now())",
    0,
  ],
  [
    "function clock() { return Date.now() }; function first(...values) { return values[0].label }; const displayed = first({ label: 'stable', time: clock() })",
    0,
  ],
  [
    "function clock() { return Date.now() }; function first(...values) { return values[0].time }; const displayed = first({ label: 'stable', time: clock() })",
    1,
  ],
  [
    "function clock() { return Date.now() }; function label() { function first(...values) { return values[0] }; return first('stable', clock()) }; const displayed = label()",
    0,
  ],
  [
    "async function clock() { return { nested: { label: 'Ready', time: Date.now() } } }; const displayed = await clock().then(({ nested: { label } }) => label)",
    0,
  ],
  [
    "async function clock() { return { nested: { label: 'Ready', time: Date.now() } } }; const displayed = await clock().then(({ nested: { time: timestamp } }) => timestamp)",
    1,
  ],

  ["const source = []; source.push(1); const displayed = source.map(() => Date.now())", 1],
  ["const source = [1]; source.length = 0; const displayed = source.map(() => Date.now())", 0],
  [
    "function clock() { return Date.now() }; function first(...values) { return values[0] }; const displayed = first('stable', clock())",
    0,
  ],
  [
    "function clock() { return Date.now() }; function first(...values) { return values[0] }; const displayed = first(clock(), 'stable')",
    1,
  ],
  [
    "function clock() { return Date.now() }; function second(fixed, ...values) { return values[1] }; const displayed = second(null, 'stable', clock())",
    1,
  ],
  [
    "function label() { let local; local = 1; if (Date.now()) return 'Ready'; return 'Ready' }; const displayed = label()",
    0,
  ],
  [
    "let displayed = 'stable'; async function initialize() { await later(); displayed = Date.now() }; await Promise.race([initialize(), Promise.resolve()])",
    0,
  ],
  [
    "let displayed = 'stable'; async function initialize() { await later(); displayed = Date.now() }; await Promise.any([initialize(), Promise.resolve()])",
    0,
  ],
  [
    "let displayed = 'stable'; async function initialize() { await later(); displayed = Date.now() }; await Promise.allSettled([initialize()])",
    1,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await Promise.race([clock()])",
    1,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await Promise.any([clock()])",
    1,
  ],
  [
    "async function clock() { return { label: 'Ready', generatedAt: Date.now() } }; const displayed = await clock().then(({ label }) => label)",
    0,
  ],
  [
    "async function clock() { return { label: 'Ready', generatedAt: Date.now() } }; const displayed = await clock().then(({ generatedAt }) => generatedAt)",
    1,
  ],
  [
    "async function clock() { return ['Ready', Date.now()] }; const displayed = await clock().then(([label]) => label)",
    0,
  ],
  [
    "async function clock() { return ['Ready', Date.now()] }; const displayed = await clock().then(([, generatedAt]) => generatedAt)",
    1,
  ],
])("handles reviewed hydration boundaries: %s", async (script, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">${script}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["const source = [1, ,]; source.pop(); const displayed = source.map(() => Date.now())", 1],
  ["const source = [, 1]; source.shift(); const displayed = source.map(() => Date.now())", 1],
  ["const source = []; source.length = 1; const displayed = source.map(() => Date.now())", 0],
  ["const source = []; source.length = 1; const displayed = source.find(() => Date.now())", 1],
  ["const source = [, 1]; source.length = 1; const displayed = source.map(() => Date.now())", 0],
  [
    "async function clock() { return Date.now() }; let pending; pending = clock(); const displayed = await pending",
    1,
  ],
  [
    "async function clock() { return Date.now() }; let pending; pending = clock(); pending = Promise.resolve('stable'); const displayed = await pending",
    0,
  ],
  [
    "async function clock() { return Date.now() }; const displayed = await clock().then(undefined)",
    1,
  ],
  ["async function clock() { return Date.now() }; const displayed = await clock().then(void 0)", 1],
  [
    "async function clock() { return Date.now() }; const undefined = () => 'stable'; const displayed = await clock().then(undefined)",
    0,
  ],
  ["function Clock() { this.generatedAt = Date.now() }; const displayed = new Clock()", 1],
])("preserves reviewed hydration flow: %s", async (setup, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">${setup}</script><template>{{ displayed.generatedAt ?? displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["this.generatedAt = Date.now(); this.label = 'stable'", "new Clock()", "generatedAt", 1],
  ["this.generatedAt = Date.now(); this.label = 'stable'", "new Clock()", "label", 0],
  [
    "this.generatedAt = Date.now(); return { generatedAt: 'stable' }",
    "new Clock()",
    "generatedAt",
    0,
  ],
  ["this.generatedAt = Date.now(); return 1 + 2", "new Clock()", "generatedAt", 1],
  ["this.generatedAt = Date.now(); return /stable/", "new Clock()", "generatedAt", 0],
  ["this.generatedAt = Date.now(); return true ? 1 : {}", "new Clock()", "generatedAt", 1],
  ["this.generatedAt = Date.now(); return 1 || {}", "new Clock()", "generatedAt", 1],
  ["this.generatedAt = Date.now(); return 0 && {}", "new Clock()", "generatedAt", 1],
  ["this.generatedAt = Date.now(); return 'key' in 1", "new Clock()", "generatedAt", 0],
  ["this.generatedAt = Date.now()", "Clock()", "generatedAt", 0],
])("projects constructor instance writes: %s %s %s", async (body, call, key, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup lang="ts">function Clock() { ${body} }; const displayed = ${call}</script><template>{{ displayed.${key} }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["[undefined].map(clock)", 1],
  ["[1].map(clock)", 0],
  ["[1, undefined].map(clock)", 1],
  ["[, 1].map(clock)", 0],
  ["[, 1].find(clock)", 1],
  ["[1].reduce(clock, undefined)", 1],
  ["[1, 2].reduce(clock)", 0],
  ["[1, undefined].reduce((sum, value = Date.now()) => value, 0)", 1],
  ["Array.from([undefined], clock)", 1],
  ["Array.from([1], clock)", 0],
  ["[1, 2].sort(clock)", 0],
])("respects array callback inputs for parameter defaults: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>function clock(value = Date.now()) { return value }; const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["[, 1].map((value = Date.now()) => value)", 0],
  ["[1].map((value, index = Date.now()) => index)", 0],
  ["[1].map((value, index, array = Date.now()) => array)", 0],
  ["[1].reduce((sum = Date.now()) => sum, undefined)", 1],
  ["[1, 2].reduce((sum, value = Date.now()) => value, 0)", 0],
  ["Array.from([,], (value = Date.now()) => value)", 1],
  ["Array.from([1], (value, index = Date.now()) => index)", 0],
  ["[undefined, 1, 2].sort((value = Date.now()) => value)", 0],
])("respects array callback parameter positions: %s", async (expression, count) => {
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    `<script setup>const displayed = ${expression}</script><template>{{ displayed }}</template>`,
  );
  expect(result.diagnostics).toHaveLength(count);
});
