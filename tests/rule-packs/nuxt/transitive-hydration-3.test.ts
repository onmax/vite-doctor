import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../rule-fixtures.ts";
import { noTimeDependentRenderWithoutNuxtTimeOrClientOnly } from "../../../src/rule-packs/nuxt/rules/nuxt/no-time-dependent-render-without-nuxt-time-or-client-only.ts";

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
