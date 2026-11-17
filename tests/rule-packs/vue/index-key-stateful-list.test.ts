import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { noIndexKeyOnStatefulList } from "../../../src/rule-packs/vue/rules/vue/no-index-key-on-stateful-list.ts";

const RULE_ID = "vue/template/no-index-key-on-stateful-list";

const STATEFUL = `<script setup lang="ts">\nconst open = ref(false)\n</script>\n<template><div @click="open = !open"><slot /></div></template>`;
const project = createProjectFixture({
  framework: "vue",
  files: {
    "Row.vue": STATEFUL,
    "TodoRow.vue": STATEFUL,
    "Tab.vue": STATEFUL,
    "Cell.vue": STATEFUL,
    "components/Line.vue": `<script setup lang="ts">\nconst props = defineProps<{ variant?: string }>()\nconst classes = computed(() => ["line", props.variant])\n</script>\n<template><span :class="classes"><slot /></span></template>`,
    "components/Measured.vue": `<script setup lang="ts">\nconst root = ref<HTMLElement>()\nconst size = useElementSize(root)\n</script>\n<template><div ref="root">{{ size }}</div></template>`,
    "components/RelativeTime.vue": `<script lang="ts">\nconst now = ref(Date.now())\n</script>\n<script setup lang="ts">\ndefineProps<{ value: string }>()\n</script>\n<template><UTooltip><time>{{ value }} {{ now }}</time></UTooltip></template>`,
    "components/Model.vue": `<script setup lang="ts">\nconst value = defineModel<string>()\n</script>\n<template><span>{{ value }}</span></template>`,
    "components/Field.vue": `<script setup lang="ts">\ndefineProps<{ label: string }>()\n</script>\n<template><label>{{ label }} <input></label></template>`,
    "components/Disclosure.vue": `<template><details><summary><slot name="title" /></summary><slot /></details></template>`,
    "components/Wrapper.vue": `<script setup lang="ts">\nimport Field from './Field.vue'\n</script>\n<template><div><Field label="x" /></div></template>`,
    "components/Options.vue": `<script>\nexport default { data: () => ({ open: false }) }\n</script>\n<template><div>{{ open }}</div></template>`,
  },
});
afterAll(() => project.dispose());

const IMPORTS = ["Row", "TodoRow", "Tab", "Cell"]
  .map((name) => `import ${name} from './${name}.vue'`)
  .join("\n");

function sfc(template: string, script = "const items = ref([])") {
  return `<script setup lang="ts">\n${IMPORTS}\n${script}\n</script>\n<template>\n${template}\n</template>`;
}

function diagnose(template: string, script?: string) {
  return project.run({
    rule: noIndexKeyOnStatefulList,
    files: { "app.vue": sfc(template, script) },
  });
}

test.each([
  ["a component", '<TodoRow v-for="(item, index) in items" :key="index" :item="item" />'],
  ["a kebab-case component", '<todo-row v-for="(item, i) in items" :key="i" :item="item" />'],
  [
    "a checkbox with v-model",
    '<input v-for="(item, i) in items" :key="i" type="checkbox" v-model="item.done">',
  ],
  ["a native input", '<input v-for="(item, i) in items" :key="i" :value="item.name">'],
  ["a textarea", '<textarea v-for="(item, i) in items" :key="i" />'],
  ["a select with v-model", '<select v-for="(item, i) in items" :key="i" v-model="item.choice" />'],
  [
    "a TransitionGroup child",
    '<TransitionGroup tag="ul"><li v-for="(item, i) in items" :key="i">{{ item.text }}</li></TransitionGroup>',
  ],
  [
    "a transition-group child",
    '<transition-group tag="ul"><li v-for="(item, i) in items" :key="i">{{ item.text }}</li></transition-group>',
  ],
  ["a template literal key", '<Row v-for="(item, i) in items" :key="`row-${i}`" />'],
  ["a concatenated key", '<Row v-for="(item, i) in items" :key="\'row-\' + i" />'],
  ["v-bind:key", '<Row v-for="(item, rowIndex) in items" v-bind:key="rowIndex" />'],
  ["the object iteration index", '<Row v-for="(value, name, index) in record" :key="index" />'],
  [
    "an array index with a positional alias",
    '<Row v-for="(item, position) in items" :key="position" />',
  ],
  ["a destructured item", '<Row v-for="({ title }, i) in items" :key="i" :title="title" />'],
  [
    "a template v-for with a component child",
    '<template v-for="(item, i) in items" :key="i"><Row :item="item" /><hr></template>',
  ],
  ["props list", '<Row v-for="(item, i) in props.items" :key="i" />'],
])("reports an index key on %s", async (_name, template) => {
  const result = await diagnose(template);
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([RULE_ID]);
  expect(result.diagnostics[0]!.code).toBe("VUE0035");
});

test.each([
  ["a plain element", '<li v-for="(item, i) in items" :key="i">{{ item.text }}</li>'],
  ["a stable item key", '<Row v-for="(item, i) in items" :key="item.id" :position="i" />'],
  ["a key mixing item and index", '<Row v-for="(item, i) in items" :key="`${item.type}-${i}`" />'],
  ["an object property key", '<Row v-for="(value, name) in record" :key="name" />'],
  ["a key alias named key", '<Row v-for="(value, key) in record" :key="key" />'],
  ["an object property alias named index", '<Row v-for="(value, index) in record" :key="index" />'],
  [
    "an inline object property alias named index",
    '<Row v-for="(value, index) in { foo: 1 }" :key="index" />',
  ],
  ["an array third alias", '<Row v-for="(item, key, index) in items" :key="index" />'],
  ["a numeric range", '<Row v-for="(n, i) in 5" :key="i" />'],
  ["an inline array literal", "<Row v-for=\"(label, i) in ['a', 'b']\" :key=\"i\" :label />"],
  ["a hidden input", '<input v-for="(item, i) in items" :key="i" type="hidden" :value="item">'],
  ["a submit input", '<input v-for="(item, i) in items" :key="i" type="submit" :value="item">'],
  ["a RouterLink", '<RouterLink v-for="(link, i) in items" :key="i" :to="link.to" />'],
  ["a NuxtLink", '<NuxtLink v-for="(link, i) in items" :key="i" :to="link.to" />'],
  ["a missing key", '<Row v-for="(item, i) in items" />'],
  ["a static key attribute", '<Row v-for="(item, i) in items" key="index" />'],
  [
    "a template v-for with plain children",
    '<template v-for="(item, i) in items" :key="i"><dt>{{ item.term }}</dt><dd>{{ item.text }}</dd></template>',
  ],
  [
    "an outer index on an inner list",
    '<div v-for="(row, i) in items" :key="row.id"><Cell v-for="cell in row.cells" :key="cell.id" :row="i" /></div>',
  ],
])("stays silent for %s", async (_name, template) => {
  const result = await diagnose(template);
  expect(result.diagnostics).toEqual([]);
});

test("skips top-level const array literals that never change", async () => {
  const result = await diagnose(
    '<Tab v-for="(tab, i) in tabs" :key="i" :label="tab" />',
    "const tabs = ['Profile', 'Billing'] as const",
  );
  expect(result.diagnostics).toEqual([]);
});

test("still reports a reactive array binding", async () => {
  const result = await diagnose(
    '<Tab v-for="(tab, i) in tabs" :key="i" :label="tab" />',
    "const tabs = ref(['a'])",
  );
  expect(result.diagnostics).toHaveLength(1);
});

test("names the failure mode and the state the child keeps", async () => {
  const result = await diagnose(
    '<TodoRow v-for="(todo, index) in items" :key="index" :todo="todo" />',
  );
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.why).toContain('v-for index "index" on <TodoRow>');
  expect(diagnostic!.why).toContain("component instance");
  expect(diagnostic!.why).toContain("TodoRow.vue keeps local state in ref()");
  expect(diagnostic!.confidence).toBe("heuristic-medium");
  expect(diagnostic!.message ?? "").not.toBe("");
});

test.each([
  ["defineModel()", '<Model v-for="(item, i) in items" :key="i" />', "defineModel()"],
  [
    "a native control in its template",
    '<Field v-for="(item, i) in items" :key="i" :label="item" />',
    "<input>",
  ],
  ["a <details> element", '<Disclosure v-for="(item, i) in items" :key="i" />', "<details>"],
  ["a stateful child component", '<Wrapper v-for="(item, i) in items" :key="i" />', "<input>"],
  ["Options API data()", '<Options v-for="(item, i) in items" :key="i" />', "data()"],
])("reports a component that keeps state through %s", async (_name, template, evidence) => {
  const names = ["Model", "Field", "Disclosure", "Wrapper", "Options"];
  const result = await diagnose(
    template,
    `${names.map((name) => `import ${name} from './components/${name}.vue'`).join("\n")}\nconst items = ref([])`,
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.why).toContain(evidence);
});

test.each([
  [
    "a child with props, computed and a slot",
    '<Line v-for="(line, index) in lines" :key="index" :variant="line.variant"><component :is="line" /></Line>',
  ],
  [
    "a child whose only ref is a template ref",
    '<Measured v-for="(line, index) in lines" :key="index" />',
  ],
  [
    "a child that shares a module-level clock",
    '<template v-for="(part, index) in lines" :key="index"><RelativeTime :value="part" /></template>',
  ],
  [
    "a component Doctor cannot read",
    '<CodeBlockLine v-for="(line, index) in lines" :key="index"><component :is="line" /></CodeBlockLine>',
  ],
  ["a dynamic component", '<component :is="item.cmp" v-for="(item, idx) in lines" :key="idx" />'],
])("stays silent for %s", async (_name, template) => {
  const names = ["Line", "Measured", "RelativeTime"];
  const result = await diagnose(
    template,
    `${names.map((name) => `import ${name} from './components/${name}.vue'`).join("\n")}\nconst lines = ref([])`,
  );
  expect(result.diagnostics).toEqual([]);
});

test("reports a component Doctor cannot read whose name says it holds input, with low confidence", async () => {
  const result = await diagnose(
    '<UInput v-for="(item, i) in items" :key="i" :model-value="item" />',
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-low");
  expect(result.diagnostics[0]!.why).toContain("could not read <UInput>");
});

test.each([
  [
    "the template reads it",
    '<TodoRow v-for="(todo, index) in items" :key="index" :todo-id="todo.id" />',
    "",
    ':key=\\"todo.id\\"',
  ],
  [
    "an array literal has it",
    '<TodoRow v-for="(todo, index) in todos" :key="index" :todo="todo" />',
    "const todos = ref([{ id: 1, title: 'a' }])",
    ':key=\\"todo.id\\"',
  ],
  [
    "the item type has it",
    '<TodoRow v-for="(todo, index) in todos" :key="index" :todo="todo" />',
    "interface Todo { id: string; title: string }\nconst todos = ref<Todo[]>([])",
    ':key=\\"todo.id\\"',
  ],
  [
    "a prop type has another unique field",
    '<Row v-for="(entry, index) in props.entries" :key="index" :entry="entry" />',
    "interface Entry { uuid: string }\nconst props = defineProps<{ entries: Entry[] }>()",
    ':key=\\"entry.uuid\\"',
  ],
])("suggests the item's key field when %s", async (_name, template, script, expected) => {
  const result = await diagnose(template, script || undefined);
  expect(result.diagnostics).toHaveLength(1);
  expect(JSON.stringify(result.diagnostics[0])).toContain(expected);
});

test("suggests a stable field without naming one when the item shows none", async () => {
  const result = await diagnose(
    '<Row v-for="(button, index) in buttons" :key="index" v-bind="button" />',
    "const buttons = ref([{ label: 'Save' }])",
  );
  expect(result.diagnostics).toHaveLength(1);
  const text = JSON.stringify(result.diagnostics[0]);
  expect(text).not.toContain("button.id");
  expect(text).toContain("a stable, unique field of the item");
});

test("is part of the recommended preset", () => {
  expect(vueRulePack.presets.recommended).toContain(RULE_ID);
});
