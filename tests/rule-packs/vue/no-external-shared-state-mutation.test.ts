import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import { noExternalSharedStateMutation } from "../../../src/rule-packs/vue/rules/vue/index.ts";

const RULE_ID = "vue/state/no-external-shared-state-mutation";

const store = `import { reactive } from 'vue'

export const store = reactive({ count: 0 })

export function increment() {
  store.count++
}
`;

const scriptWriter = `<script setup lang="ts">
import { store } from '../store'

function bump() {
  store.count++
}
</script>
<template><button @click="bump">{{ store.count }}</button></template>`;

const templateWriter = `<script setup lang="ts">
import { store } from '../store'
</script>
<template>
  <button @click="store.count = 0">Reset</button>
</template>`;

function run(files: Record<string, string>) {
  return runRuleFixture({ rule: noExternalSharedStateMutation, files });
}

const relativeTo = (root: string, file: string) => file.slice(root.length + 1);

test("VUE0048 is strict-only", () => {
  expect(vueRulePack.presets.recommended).not.toContain(RULE_ID);
  expect(vueRulePack.presets.strict).toContain(RULE_ID);
});

const writer = `import { store } from './store'; store.count++`;

test.each([
  `function reset() { store.count = 0 }; export type { reset }`,
  `function reset() { store.count = 0 }; export { type reset }`,
  `export function getReset() { return () => store.count++ }`,
  `export function* reset() { store.count++ }`,
])("VUE0048 does not recommend a non-action: %s", async (action) => {
  const result = await run({
    "src/store.ts": `export const store = reactive({ count: 0 }); ${action}`,
    "src/a.ts": writer,
    "src/b.ts": writer,
  });
  expect(result.diagnostics).toEqual([]);
});

test("VUE0048 names callable actions by their public exports and keys", async () => {
  const result = await run({
    "src/store.ts": `const key = 'reset';
const internal = reactive({ count: 0, get next() { return this.count++ },
  [key]() { this.count = 0 }, ['clear']() { this.count = 0 },
  later() { return () => this.count++ } });
export { internal as store };
export default function internalReset() { internal.count = 0 }`,
    "src/a.ts": writer,
    "src/b.ts": writer,
  });
  expect(result.diagnostics.map(({ why }) => why)).toEqual([
    expect.stringMatching(/default export.*store\.reset\(\).*store\.clear\(\)/),
  ]);
  expect(result.diagnostics[0]!.why).not.toMatch(/next|later|internalReset|store\.key/);
});

test("VUE0048 follows destructuring targets, not keys or default reads", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/a.ts": `import { store } from './store'; ({ count: [store.count = 1] } = payload)`,
    "src/b.ts": `import { store } from './store'; [...store.items] = values`,
    "src/c.ts": `import { store } from './store'; ({ [store.count]: x = store.count } = payload)`,
  });
  expect(result.diagnostics[0]?.related?.map(({ file }) => relativeTo(result.root, file))).toEqual([
    "src/a.ts",
    "src/b.ts",
  ]);
});

test.each([
  `export * from './store'; export { store } from './other'`,
  `export * from './store'; export * from './other'`,
  `import { store } from './store'; export type { store }`,
])("VUE0048 ignores shadowed, ambiguous, and erased exports: %s", async (barrel) => {
  const result = await run({
    "src/store.ts": store,
    "src/other.ts": `export const store = { count: 0 }`,
    "src/index.ts": barrel,
    "src/a.ts": `import { store } from './index'; store.count++`,
    "src/b.ts": `import { store } from './index'; store.count++`,
  });
  expect(result.diagnostics).toEqual([]);
});

test("VUE0048 follows default forwarding and a namespace re-export", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/index.ts": `import { store } from './store'; export default store; export * as state from './store'`,
    "src/a.ts": `import store from './index'; store.count++`,
    "src/b.ts": `import * as barrel from './index'; barrel.state.store.count++`,
  });
  expect(result.diagnostics[0]?.related).toHaveLength(2);
});

test("VUE0048 follows distinct export slots through cyclic barrels", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/index.ts": `export { store } from './store';
export { forwarded as publicStore } from './forward';
export * as self from './index'`,
    "src/forward.ts": `export { store as forwarded } from './index'`,
    "src/a.ts": `import { publicStore } from './index'; publicStore.count++`,
    "src/b.ts": `import { self } from './index'; self.publicStore.count++`,
  });
  expect(result.diagnostics[0]?.related?.map(({ file }) => relativeTo(result.root, file))).toEqual([
    "src/a.ts",
    "src/b.ts",
  ]);
});

test("VUE0048 follows imports hoisted from script setup into ordinary script", async () => {
  const component = `<script>
export function bump() { counter.count++ }
function ignore(counter) { counter.count++ }
</script>
<script setup>import { store as counter } from './store'</script>`;
  const result = await run({
    "src/store.ts": store,
    "src/a.ts": writer,
    "src/Hoisted.vue": component,
  });
  expect(
    result.diagnostics[0]?.related
      ?.filter(({ file }) => file.endsWith(".vue"))
      .map(({ range }) => [range?.line, component.slice(range?.start, range?.end)]),
  ).toEqual([[2, "counter.count++"]]);
});

test("VUE0048 distinguishes hoisted imports from setup-local and type-only Object bindings", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/object.ts": `export const Object = { assign: () => ({}) }`,
    "src/Imported.vue": `<script lang="ts">
import { store } from './store'
export function reset() { Object.assign(store, {}) }
</script>
<script setup lang="ts">import { Object } from './object'</script>`,
    "src/Local.vue": `<script lang="ts">
import { store } from './store'
export function reset() { Object.assign(store, {}) }
</script>
<script setup lang="ts">const Object = { assign: () => ({}) }</script>`,
    "src/TypeOnly.vue": `<script lang="ts">
import { store } from './store'
export function reset() { Object.assign(store, {}) }
</script>
<script setup lang="ts">import { type Object } from './object'</script>`,
  });
  expect(result.diagnostics[0]?.related?.map(({ file }) => relativeTo(result.root, file))).toEqual([
    "src/Local.vue",
    "src/TypeOnly.vue",
  ]);
});

test("VUE0048 respects setup shadowing and the implicit event parameter", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/a.ts": writer,
    "src/Shadow.vue": `<script>import { store } from './store'</script>
<script setup>const store = { count: 0 }</script>
<template><button @click="store.count++" /></template>`,
    "src/Event.vue": `<script setup>import { store as $event } from './store'</script>
<template><button @click="$event.count++" /></template>`,
  });
  expect(result.diagnostics).toEqual([]);
});

test("VUE0048 uses Vue directive scopes and exact raw template ranges", async () => {
  const component = `<script>import { store } from './store'</script>
<script setup>const ready = true</script>
<template>
  <button v-if="ready &amp;&amp; store.count++" v-for="store in store.items.sort()" @click="store.count++" />
  <button @[store.count++]="ready &amp;&amp; store.count++" />
</template>`;
  const result = await run({
    "src/store.ts": store.replace("count: 0", "count: 0, items: []"),
    "src/a.ts": writer,
    "src/Template.vue": component,
  });
  expect(
    result.diagnostics[0]?.related
      ?.filter(({ file }) => file.endsWith(".vue"))
      .map(({ range }) => component.slice(range?.start, range?.end)),
  ).toEqual(["store.count++", "store.items.sort()", "store.count++", "store.count++"]);
});

test("VUE0048 detects known collection writes but not calls to app actions or shadowed Object", async () => {
  const result = await run({
    "src/store.ts": `export const store = reactive({ count: 0, push() { this.count++ },
  actions: { clear() {} } });
export const map = reactive(new Map());
export function reset() { map.clear() }`,
    "src/a.ts": `import { store, map } from './store'; store.push(); map.set('x', 1)`,
    "src/b.ts": `import { store, map } from './store'; store.actions.clear(); map.delete('x')`,
    "src/c.ts": `import { store } from './store'; const Object = { assign: () => ({}) }; Object.assign(store, {})`,
  });
  expect(result.diagnostics.map(({ why, related }) => [why, related?.length])).toEqual([
    [expect.stringContaining('"map"'), 2],
  ]);
});

test("VUE0048 reports shared state that two components write past its mutators", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/components/A.vue": scriptWriter,
    "src/components/B.vue": templateWriter,
  });

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VUE0048"]);
  const [diagnostic] = result.diagnostics;
  expect(relativeTo(result.root, diagnostic!.file)).toBe("src/store.ts");
  expect(diagnostic!.range?.line).toBe(3);
  expect(diagnostic!.why).toContain("increment()");
  expect(diagnostic!.why).toContain("2 other files write it directly");
  expect(
    diagnostic!.related?.map((item) => [
      relativeTo(result.root, item.file),
      item.range?.line,
      item.message,
    ]),
  ).toEqual([
    ["src/components/A.vue", 5, "Writes store.count directly"],
    ["src/components/B.vue", 5, "Writes store.count directly in the template"],
  ]);
});

test("VUE0048 follows re-exports, namespace imports, refs, v-model, and store methods", async () => {
  const result = await run({
    "src/state/counter.ts": `import { ref } from 'vue'
export const items = ref<string[]>([])
export const add = (item: string) => { items.value.push(item) }
`,
    "src/state/index.ts": `export * from './counter'`,
    "src/state/session.ts": `import { reactive } from 'vue'
const session = reactive({
  user: '',
  login(name: string) { this.user = name },
})
export { session as default }
`,
    "src/components/List.vue": `<script setup lang="ts">
import * as state from '../state'
import session from '../state/session'
state.items.value.splice(0, 1)
</script>
<template><input v-model="session.user"></template>`,
    "src/components/Form.vue": `<script setup lang="ts">
import { items } from '../state'
import session from '../state/session'
</script>
<template><button @click="items.push('x'); session.user = ''">Add</button></template>`,
  });

  expect(
    result.diagnostics.map((diagnostic) => [
      relativeTo(result.root, diagnostic.file),
      diagnostic.related?.map((item) => [relativeTo(result.root, item.file), item.message]),
    ]),
  ).toEqual([
    [
      "src/state/counter.ts",
      [
        ["src/components/Form.vue", "Writes items directly in the template"],
        ["src/components/List.vue", "Writes state.items.value directly"],
      ],
    ],
    [
      "src/state/session.ts",
      [
        ["src/components/Form.vue", "Writes session.user directly in the template"],
        ["src/components/List.vue", "Writes session.user directly in the template"],
      ],
    ],
  ]);
  expect(result.diagnostics[1]!.why).toContain("login() on the default export");
});

test("VUE0048 stays silent when components call the mutators", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/components/A.vue": `<script setup lang="ts">
import { increment, store } from '../store'
</script>
<template><button @click="increment()">{{ store.count }}</button></template>`,
    "src/components/B.vue": `<script setup lang="ts">
import { increment } from '../store'
increment()
</script>`,
  });
  expect(result.diagnostics).toEqual([]);
});

test("VUE0048 stays silent with a single external writer", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/components/A.vue": scriptWriter,
    "src/components/B.vue": `<script setup lang="ts">
import { store } from '../store'
</script>
<template><p>{{ store.count }}</p></template>`,
  });
  expect(result.diagnostics).toEqual([]);
});

test("VUE0048 stays silent when the module exports no mutator", async () => {
  const result = await run({
    "src/store.ts": `import { reactive } from 'vue'
export const store = reactive({ count: 0 })
export function read() {
  return store.count
}
`,
    "src/components/A.vue": scriptWriter,
    "src/components/B.vue": templateWriter,
  });
  expect(result.diagnostics).toEqual([]);
});

test("VUE0048 stays silent on reads, shadowed names, and aliases", async () => {
  const result = await run({
    "src/store.ts": store,
    "src/components/A.vue": `<script setup lang="ts">
import { store } from '../store'
const total = store.count + 1
const copy = { ...store }
copy.count = 2
</script>
<template>
  <p>{{ store.count }} {{ total }}</p>
  <div v-for="store in [{ count: 1 }]" :key="store.count" @click="store.count++" />
</template>`,
    "src/components/B.vue": `<script setup lang="ts">
import { store } from '../store'
function local(store: { count: number }) {
  store.count = 3
}
</script>
<template><p>{{ store.count }}</p></template>`,
  });
  expect(result.diagnostics).toEqual([]);
});
