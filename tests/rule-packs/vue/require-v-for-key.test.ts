import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { requireVForKey } from "../../../src/rule-packs/vue/rules/vue/require-v-for-key.ts";

const RULE_ID = "vue/template/require-v-for-key";

const STATEFUL = `<script setup lang="ts">\nconst open = ref(false)\n</script>\n<template><div @click="open = !open"><slot /></div></template>`;
const project = createProjectFixture({
  framework: "vue",
  files: {
    "Row.vue": STATEFUL,
    "TodoRow.vue": STATEFUL,
    "Cell.vue": STATEFUL,
    "MyComp.vue": STATEFUL,
    "Line.vue": `<script setup lang="ts">\ndefineProps<{ text: string }>()\n</script>\n<template><span>{{ text }}</span></template>`,
  },
});
afterAll(() => project.dispose());

const IMPORTS = ["Row", "TodoRow", "Cell", "MyComp", "Line"]
  .map((name) => `import ${name} from './${name}.vue'`)
  .join("\n");

function diagnose(template: string, script = "const list = ref([])\nconst items = ref([])") {
  return project.run({
    rule: requireVForKey,
    files: {
      "app.vue": `<script setup lang="ts">\n${IMPORTS}\n${script}\n</script>\n<template>\n${template}\n</template>`,
    },
  });
}

test.each([
  // Ported from eslint-plugin-vue's valid cases.
  ["v-bind:key", '<div><div v-for="x in list" v-bind:key="x"></div></div>'],
  [":key", '<div><div v-for="x in list" :key="x.foo"></div></div>'],
  [
    "an unknown custom component",
    '<div><custom-component v-for="x in list"></custom-component></div>',
  ],
  [
    "a key on the template child",
    '<div><template v-for="x in list"><div :key="x"></div></template></div>',
  ],
  ["a slot outlet", '<div><slot v-for="x in list" :name="x"></slot></div>'],
  [
    "a slot outlet with a keyed fallback",
    '<div><slot v-for="x in list" :name="x"><div :key="x"></div></slot></div>',
  ],
  [
    "v-bind:key on the template",
    '<div><template v-for="x in list" v-bind:key="x"><MyComp /></template></div>',
  ],
  [
    ":key on the template",
    '<div><template v-for="x in list" :key="x.id"><MyComp /></template></div>',
  ],
  ["a keyed slot outlet", '<div><slot v-for="x in list" :key="x"><MyComp /></slot></div>'],
  // eslint-plugin-vue reports these; their items hold no state, so Vue's in-place patch is correct.
  ["an unkeyed element with text only", '<div><div v-for="x in list">{{ x.text }}</div></div>'],
  ["an element with a static key", '<div><div v-for="x in list" key="100"></div></div>'],
  [
    "a template with plain children",
    '<div><template v-for="x in list"><div></div></template></div>',
  ],
  [
    "a slot outlet with a plain fallback",
    '<div><slot v-for="x in list" :name="x"><div></div></slot></div>',
  ],
  // Doctor's narrowing.
  ["a stateless component", '<Line v-for="item in items" :text="item.text" />'],
  ["a RouterLink", '<RouterLink v-for="link in items" :to="link.to" />'],
  ["a hidden input", '<input v-for="item in items" type="hidden" :value="item.value">'],
  ["a v-bind object spread", '<Row v-for="item in items" v-bind="item" />'],
  ["a dynamic v-bind argument", '<Row v-for="item in items" :[attr]="item.id" />'],
  [
    "a template child with a v-bind spread",
    '<template v-for="item in items"><Row v-bind="item" /></template>',
  ],
  ["a numeric range", '<Row v-for="n in 5" />'],
  ["an inline array literal", "<Row v-for=\"label in ['a', 'b']\" :label />"],
  ["a string literal", "<input v-for=\"letter in 'abc'\">"],
  ["a static template string", '<input v-for="letter in `abc`">'],
  [
    "a conditional transition fragment",
    '<TransitionGroup><li v-if="show" v-for="item in items">{{ item.name }}</li></TransitionGroup>',
  ],
  [
    "a text-only transition fragment",
    '<TransitionGroup><template v-for="item in items">{{ item.name }}</template></TransitionGroup>',
  ],
  [
    "a named slot declared on TransitionGroup itself",
    '<TransitionGroup v-slot:other><li v-for="n in 3">{{ n }}</li></TransitionGroup>',
  ],
  [
    "an unknown slot declared on TransitionGroup itself",
    '<TransitionGroup v-slot:[slotName]><li v-for="n in 3">{{ n }}</li></TransitionGroup>',
  ],
  ["an empty nested loop with state", '<div v-for="item in items"><input v-for="n in []"></div>'],
  [
    "an empty nested transition loop",
    '<TransitionGroup><template v-for="item in items"><li v-for="n in []">{{ n }}</li></template></TransitionGroup>',
  ],
])("stays silent for %s", async (_name, template) => {
  const result = await diagnose(template);
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["a component that keeps state", '<TodoRow v-for="todo in items" :todo="todo" />'],
  ["a kebab-case component", '<todo-row v-for="todo in items" :todo="todo" />'],
  ["an input with v-model", '<input v-for="item in items" v-model="item.name">'],
  ["a native input", '<input v-for="item in items" :placeholder="item.label">'],
  ["a textarea", '<textarea v-for="item in items" />'],
  ["a fixed nested loop with state", '<div v-for="item in items"><input v-for="n in 1"></div>'],
  [
    "a TransitionGroup child",
    '<TransitionGroup tag="ul"><li v-for="item in items">{{ item.text }}</li></TransitionGroup>',
  ],
  [
    "a template with a component child",
    '<template v-for="item in items"><MyComp /><hr></template>',
  ],
  ["a component inside an unkeyed element", '<li v-for="item in items"><Row :item="item" /></li>'],
  [
    "a v-model input deep inside an element",
    '<li v-for="item in items"><label><input v-model="item.done" type="checkbox"></label></li>',
  ],
  ["props list", '<Row v-for="item in props.items" />'],
  [
    "a dropped spread on the structural template",
    '<template v-for="item in items" v-bind="item"><input :placeholder="item.name"></template>',
  ],
  [
    "a spread on one of several template children",
    '<template v-for="item in items"><input v-bind="item"><hr></template>',
  ],
  [
    "a keyed loop in a structural template",
    '<template v-for="item in items"><li v-for="child in item.children" :key="child.id"/><input :placeholder="item.name"></template>',
  ],
  [
    "a keyed loop inside a native wrapper",
    '<div v-for="row in items"><Cell v-for="cell in row.cells" :key="cell.id" /></div>',
  ],
  ["a keyed descendant", '<li v-for="item in items"><Row :key="item.id" /></li>'],
  ["a spread over a mutable array", '<input v-for="item in [...items]" :placeholder="item.name">'],
  ["an interpolated string source", '<input v-for="letter in `a${suffix}`">'],
])("reports %s", async (_name, template) => {
  const result = await diagnose(template);
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([RULE_ID]);
  expect(result.diagnostics[0]!.code).toBe("VUE0045");
});

test("reports both unkeyed levels that can independently lose state", async () => {
  const result = await diagnose(
    '<div v-for="row in items"><Cell v-for="cell in row.cells" :cell="cell" /></div>',
  );
  expect(result.diagnostics).toHaveLength(2);
  expect(result.diagnostics.map(({ why }) => why)).toEqual([
    expect.stringContaining('<div v-for="row in items">'),
    expect.stringContaining('<Cell v-for="cell in row.cells">'),
  ]);
});

test("reports const array bindings that can be mutated in place", async () => {
  const result = await diagnose(
    '<Row v-for="tab in tabs" :label="tab" />',
    "const tabs = ['Profile', 'Billing']; function reorder() { tabs.reverse() }",
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  '<TransitionGroup><li v-for="n in 3">{{ n }}</li></TransitionGroup>',
  '<TransitionGroup v-slot:default><li v-for="n in 3">{{ n }}</li></TransitionGroup>',
  '<TransitionGroup><Row v-for="n in 3" v-slot="scope">{{ scope.label }}</Row></TransitionGroup>',
  '<TransitionGroup><template #default><li v-for="item in items">{{ item.name }}</li></template></TransitionGroup>',
  '<TransitionGroup><template v-for="item in items"><li v-for="n in 1">{{ n }}</li></template></TransitionGroup>',
])("reports a proven transition warning for %s", async (template) => {
  const result = await diagnose(template);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.confidence).toBe("proven");
  expect(result.diagnostics[0]!.why).toContain("children must be keyed");
});

test("keeps state-reuse advice when a conditional supplies a transition key", async () => {
  const result = await diagnose(
    '<TransitionGroup><input v-if="show" v-for="item in items"></TransitionGroup>',
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-medium");
  expect(result.diagnostics[0]!.why).not.toContain("children must be keyed");
});

test("names the failure mode and the state the component keeps", async () => {
  const result = await diagnose('<TodoRow v-for="todo in items" :todo="todo" />');
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.why).toContain('<TodoRow v-for="todo in items"> has no key');
  expect(diagnostic!.why).toContain("TodoRow.vue keeps local state in ref()");
  expect(diagnostic!.why).toContain("patches the list in place");
  expect(diagnostic!.confidence).toBe("heuristic-medium");
  expect(diagnostic!.evidence?.[0]?.file).toMatch(/TodoRow\.vue$/);
});

test("names the stateful descendant of an unkeyed element", async () => {
  const result = await diagnose('<li v-for="item in items"><Row :item="item" /></li>');
  expect(result.diagnostics[0]!.why).toContain(
    '<li v-for="item in items"> has no key and renders <Row>',
  );
});

test("marks unkeyed TransitionGroup children as proven", async () => {
  const result = await diagnose(
    '<TransitionGroup tag="ul"><li v-for="item in items">{{ item.text }}</li></TransitionGroup>',
  );
  expect(result.diagnostics[0]!.confidence).toBe("proven");
  expect(result.diagnostics[0]!.why).toContain("<TransitionGroup> children must be keyed.");
});

test("reports a component Doctor cannot read whose name says it holds input, with low confidence", async () => {
  const result = await diagnose('<UInput v-for="item in items" :model-value="item" />');
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-low");
  expect(result.diagnostics[0]!.why).toContain("could not read <UInput>");
});

test("suggests a key on the item's distinct literal id field", async () => {
  const template = '<TodoRow v-for="todo in items" :todo-id="todo.id" />';
  const result = await diagnose(template, "const items = ref([{ id: 1 }, { id: 2 }])");
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.suggestion).toContain(':key="todo.id"');
  expect(diagnostic!.fix?.kind).toBe("suggestion");
  const [edit] = diagnostic!.fix!.edits;
  expect(edit!.text).toBe(' :key="todo.id"');
  expect(edit!.range.start).toBe(edit!.range.end);
});

test.each([
  [
    '<div v-for="item in items"><input><span v-for="item in children">{{ item.id }}</span></div>',
    'const items = ref([{ name: "a" }])',
  ],
  [
    '<div v-for="item in items"><input :placeholder="choices.map(item => item.id).join()"></div>',
    "const items = ref([])",
  ],
  [
    '<input v-for="item in items" :placeholder="item.name">',
    'const items = ref([{ id: 1, name: "a" }, { id: 1, name: "b" }])',
  ],
  [
    '<input v-for="item in items" :placeholder="item.id">',
    "const items = ref<{ id?: string }[]>([])",
  ],
  [
    '<input v-for="item in items" :placeholder="item.id.name">',
    "const items = ref<{ id: { name: string } }[]>([])",
  ],
  [
    '<input v-for="item in items" :placeholder="item.name">',
    'const items = ref([{ name: "a" }]); const { children } = defineProps<{ items: { id: string }[]; children: string[] }>()',
  ],
  [
    '<input v-for="item in items" :placeholder="item.name">',
    "const { children: items } = defineProps<{ items: { id: string }[]; children: { name: string }[] }>()",
  ],
])("does not suggest an unverified key for %s (%s)", async (template, script) => {
  const result = await diagnose(template, script);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.fix ?? null).toBeNull();
});

test("suggests the id field from the item type", async () => {
  const result = await diagnose(
    '<TodoRow v-for="todo in todos" :todo="todo" />',
    "interface Todo { id: string; title: string }\nconst todos = ref<Todo[]>([])",
  );
  expect(JSON.stringify(result.diagnostics[0])).toContain(':key=\\"todo.id\\"');
});

test.each([
  ["items", "const { children: items } = defineProps<{ children: { id: string }[] }>()"],
  ["items", "const props = defineProps<{ items: { id: string }[] }>()"],
  ["$props.items", "const props = defineProps<{ items: { id: string }[] }>()"],
  ["props.items", "const props = defineProps<{ items: { id: string }[] }>()"],
])("suggests a key from the props binding %s", async (source, script) => {
  const result = await diagnose(`<input v-for="item in ${source}">`, script);
  expect(result.diagnostics[0]!.fix?.edits[0]?.text).toBe(' :key="item.id"');
});

test("offers no edit and never the index when the item shows no id", async () => {
  const result = await diagnose('<Row v-for="(row, index) in items" :label="row.label" />');
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.suggestion).toContain("a stable, unique field of the item");
  expect(diagnostic!.suggestion).not.toContain('"index"');
  expect(diagnostic!.fix ?? null).toBeNull();
});

test("is part of the recommended preset", () => {
  expect(vueRulePack.presets.recommended).toContain(RULE_ID);
});
