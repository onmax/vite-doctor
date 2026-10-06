import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../../src/core/testkit.ts";
import { noTimeDependentRenderWithoutNuxtTimeOrClientOnly } from "../../../src/rule-packs/nuxt/rules/nuxt/no-time-dependent-render-without-nuxt-time-or-client-only.ts";

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
  ["const displayed = Array.from({ length: 4294967296 }, () => Date.now())", "displayed", 0],
  ["const displayed = Array.from({ length: '4294967296' }, () => Date.now())", "displayed", 0],
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
