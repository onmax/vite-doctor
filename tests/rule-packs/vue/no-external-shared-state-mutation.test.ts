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
  expect(result.diagnostics[1]!.why).toContain("session.login()");
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
