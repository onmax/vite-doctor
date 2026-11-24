import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import { noShallowRefDeepMutation } from "../../../src/rule-packs/vue/rules/vue/index.ts";

const RULE_ID = "vue/reactivity/no-shallow-ref-deep-mutation";

function component(script: string, template = "<p>{{ todos.length }}</p>") {
  return `<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef, triggerRef, watch, watchEffect, watchPostEffect, watchSyncEffect } from 'vue'
${script}
</script>
<template>${template}</template>`;
}

async function run(file: string, path = "src/Todos.vue") {
  const result = await runRuleFixture({ rule: noShallowRefDeepMutation, files: { [path]: file } });
  return result.diagnostics;
}

test("VUE0049 is recommended", () => {
  expect(vueRulePack.presets.recommended).toContain(RULE_ID);
});

test.each([
  [
    "a handler pushes to the array",
    `const todos = shallowRef<string[]>([])\nfunction add(todo: string) { todos.value.push(todo) }`,
    "todos.value",
  ],
  [
    "a hook sets a nested property",
    `const todos = shallowRef({ items: [] as string[], count: 0 })\nonMounted(() => { todos.value.count++ })`,
    "todos.value.count",
  ],
  [
    "a nested array changes after an await",
    `const todos = shallowRef({ items: [] as string[] })\nasync function load() { const next = await fetchTodos(); todos.value.items.push(...next) }\nload()`,
    "todos.value.items",
  ],
  [
    "a Map changes in a timer",
    `const todos = shallowRef(new Map<string, boolean>())\nsetTimeout(() => todos.value.set('a', true), 10)`,
    "todos.value",
  ],
  [
    "two calls share the same deferred caller",
    `const todos = shallowRef([])\nfunction push(t: string) { todos.value.push(t) }\nfunction add() { push('a'); push('b') }`,
    "todos.value",
  ],
  [
    "a post-flush effect changes the array",
    `const todos = shallowRef([])\nwatchPostEffect(() => { todos.value.push('seed') })`,
    "todos.value",
  ],
  [
    "a non-immediate watcher changes the array",
    `const todos = shallowRef([]); const count = ref(0)\nwatch(count, () => todos.value.push('a'), { immediate: false })`,
    "todos.value",
  ],
  [
    "a native promise callback changes the array",
    `const todos = shallowRef([])\nPromise.resolve().then(() => todos.value.push('a'))`,
    "todos.value",
  ],
  [
    "an unrelated property is assigned during setup",
    `const todos = shallowRef({ items: [], other: [] }); todos.value.other = reactive([])\nfunction add() { todos.value.items.push('a') }`,
    "todos.value.items",
  ],
  [
    "a nested receiver is replaced with a plain array during setup",
    `const todos = shallowRef({ items: [] }); todos.value.items = []
function add() { todos.value.items.push('a') }`,
    "todos.value.items",
  ],
  [
    "a receiver ancestor is replaced with a plain object during setup",
    `const todos = shallowRef({ group: { items: [] } }); todos.value.group = { items: [] }
function add() { todos.value.group.items.push('a') }`,
    "todos.value.group.items",
  ],
])("VUE0049 reports when %s", async (_name, script, target) => {
  const diagnostics = await run(component(script));
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.ruleId).toBe(RULE_ID);
  expect(diagnostics[0]!.why).toContain(`This changes ${target} in place after setup`);
});

test("VUE0049 reports a composable whose computed() reads the ref", async () => {
  const diagnostics = await run(
    `import { computed, shallowRef } from 'vue'
export function useCart() {
  const cart = shallowRef({ lines: [] as string[] })
  const size = computed(() => cart.value.lines.length)
  function add(line: string) { cart.value.lines.push(line) }
  return { cart, size, add }
}`,
    "src/composables/useCart.ts",
  );
  expect(diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([RULE_ID]);
});

test.each([
  [
    "the function calls triggerRef()",
    `function add(t: string) { todos.value.push(t); triggerRef(todos) }`,
  ],
  [
    "another function calls triggerRef()",
    `function add(t: string) { todos.value.push(t) }\nfunction flush() { triggerRef(todos) }`,
  ],
  [
    "the function also replaces .value",
    `function add(t: string) { todos.value.push(t); todos.value = [...todos.value] }`,
  ],
  [
    "setup changes the value before the first render",
    `todos.value.push('first')\n;['a', 'b'].forEach((t) => todos.value.push(t))`,
  ],
  ["setup calls the function synchronously", `function seed() { todos.value.push('a') }\nseed()`],
  ["an immediate effect seeds the array", `watchEffect(() => { todos.value.push('seed') })`],
  ["a sync effect seeds the array", `watchSyncEffect(() => { todos.value.push('seed') })`],
  [
    "an immediate one-shot watch seeds the array",
    `watch(ref(0), () => { todos.value.push('seed') }, { immediate: true, once: true })`,
  ],
  [
    "a user-defined then runs inline",
    `const inline = { then(fn: () => void) { fn() } }; inline.then(() => todos.value.push('seed'))`,
  ],
  [
    "an await is on another branch",
    `async function seed(defer: boolean) { if (defer) await Promise.resolve(); todos.value.push('seed') }; seed(false)`,
  ],
  [
    "the function replaces .value instead",
    `function add(t: string) { todos.value = [...todos.value, t] }`,
  ],
  [
    "the ref is passed to another function",
    `function add(t: string) { todos.value.push(t) }\npersist(todos)`,
  ],
  ["a method that is not a known mutator", `function add(t: string) { todos.value.includes(t) }`],
])("VUE0049 stays quiet when %s", async (_name, body) => {
  expect(await run(component(`const todos = shallowRef<string[]>([])\n${body}`))).toEqual([]);
});

test.each([
  [
    "the value is reactive()",
    `const todos = shallowRef(reactive({ items: [] as string[] }))\nfunction add(t: string) { todos.value.items.push(t) }`,
  ],
  [
    "the value comes from elsewhere",
    `const todos = shallowRef(props.list)\nfunction add(t: string) { todos.value.push(t) }`,
  ],
  [
    "a later assignment is not a literal",
    `const todos = shallowRef<string[]>([])\nasync function load() { todos.value = await fetchTodos() }\nfunction add(t: string) { todos.value.push(t) }`,
  ],
  [
    "a nested property is not a literal",
    `const todos = shallowRef({ items: reactive<string[]>([]) })\nfunction add(t: string) { todos.value.items.push(t) }`,
  ],
  [
    "a nested receiver is replaced during setup",
    `const todos = shallowRef({ items: [] }); todos.value.items = reactive([])\nfunction add() { todos.value.items.push('a') }`,
  ],
  [
    "an accessor updates a separate ref",
    `const size = ref(0); const todos = shallowRef({ get size() { return size.value }, set size(n) { size.value = n } }); function add() { todos.value.size++ }`,
  ],
])("VUE0049 stays quiet when the inner value may be reactive: %s", async (_name, script) => {
  expect(await run(component(script, "<p>{{ todos }}</p>"))).toEqual([]);
});

test("VUE0049 stays quiet when nothing reads the ref reactively", async () => {
  expect(
    await run(
      component(
        `const todos = shallowRef<string[]>([])\nfunction add(t: string) { todos.value.push(t); console.log(todos.value) }`,
        `<button @click="console.log(todos.length); add('a')">Add</button>`,
      ),
    ),
  ).toEqual([]);
});

test.each(["todos = replacement", "todos = replacement; add()"])(
  "VUE0049 sees template replacement: %s",
  async (handler) => {
    expect(
      await run(
        component(
          `const todos = shallowRef<string[]>([])\nconst replacement = reactive<string[]>([])\nfunction add() { todos.value.push('a') }`,
          `<p>{{ todos.length }}</p><button @click="${handler}">Swap</button>`,
        ),
      ),
    ).toEqual([]);
  },
);

test.each([`@click="todos.items = replacement; add()"`, `v-model="todos.items"`])(
  "VUE0049 sees a template replacement of a nested receiver: %s",
  async (directive) => {
    expect(
      await run(
        component(
          `const todos = shallowRef({ items: [] }); const replacement = reactive([]); function add() { todos.value.items.push('a') }`,
          `<p>{{ todos.items.length }}</p><Picker ${directive} />`,
        ),
      ),
    ).toEqual([]);
  },
);

test.each([
  ["Array", "[]", "length", "push('a')"],
  ["Map", "new Map()", "size", "set('a', 1)"],
  ["Set", "new Set()", "size", "add('a')"],
])("VUE0049 stays quiet for a template-local %s constructor", async (name, init, size, mutate) => {
  expect(
    await run(
      component(
        `const todos = shallowRef({ items: ${init} }); function Replacement() { return reactive(${init}) }; function add() { todos.value.items.${mutate} }`,
        `<p>{{ todos.items.${size} }}</p><button @click="const ${name} = Replacement; todos.items = new ${name}()">Replace</button><button @click="add">Add</button>`,
      ),
    ),
  ).toEqual([]);
});

test.each(["todos.group.items = []", "todos.group = { items: [] }"])(
  "VUE0049 reports after a plain template replacement: %s",
  async (replacement) => {
    const diagnostics = await run(
      component(
        `const todos = shallowRef({ group: { items: [] } }); function add() { todos.value.group.items.push('a') }`,
        `<p>{{ todos.group.items.length }}</p><button @click="${replacement}; add()">Reset</button>`,
      ),
    );
    expect(diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([RULE_ID]);
  },
);

test("VUE0049 ignores a handler assignment to a template local", async () => {
  const diagnostics = await run(
    component(
      `const todos = shallowRef([]); function add() { todos.value.push('a') }`,
      `<p>{{ todos.length }}</p><button @click="let todos = []; todos = []; add()">Add</button>`,
    ),
  );
  expect(diagnostics).toHaveLength(1);
});

test("VUE0049 stays quiet for ref() and a shadowed shallowRef", async () => {
  expect(
    await run(
      component(`const todos = shallowRef<string[]>([])
const deep = ref<string[]>([])
function add(t: string) { deep.value.push(t) }`),
    ),
  ).toEqual([]);
  expect(
    await run(`<script setup lang="ts">
import { shallowRef } from './my-refs'
const todos = shallowRef<string[]>([])
function add(t: string) { todos.value.push(t) }
</script>
<template><p>{{ todos.length }}</p></template>`),
  ).toEqual([]);
});
