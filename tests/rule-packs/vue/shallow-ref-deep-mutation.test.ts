import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import { noShallowRefDeepMutation } from "../../../src/rule-packs/vue/rules/vue/index.ts";

const RULE_ID = "vue/reactivity/no-shallow-ref-deep-mutation";

function component(script: string, template = "<p>{{ todos.length }}</p>") {
  return `<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, triggerRef, watch } from 'vue'
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
])("VUE0049 stays quiet when the inner value may be reactive: %s", async (_name, script) => {
  expect(await run(component(script, "<p>{{ todos }}</p>"))).toEqual([]);
});

test("VUE0049 stays quiet when nothing reads the ref reactively", async () => {
  expect(
    await run(
      component(
        `const todos = shallowRef<string[]>([])\nfunction add(t: string) { todos.value.push(t); console.log(todos.value) }`,
        `<button @click="add('a')">Add</button>`,
      ),
    ),
  ).toEqual([]);
});

test("VUE0049 stays quiet when the template assigns the ref", async () => {
  expect(
    await run(
      component(
        `const todos = shallowRef<string[]>([])\nfunction add(t: string) { todos.value.push(t) }`,
        `<p>{{ todos.length }}</p><button @click="todos = other">Swap</button>`,
      ),
    ),
  ).toEqual([]);
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
