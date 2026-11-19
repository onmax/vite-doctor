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
  [
    "a nested keyed list inside an unkeyed wrapper",
    '<div v-for="row in items"><Cell v-for="cell in row.cells" :key="cell.id" /></div>',
  ],
  ["a keyed descendant", '<li v-for="item in items"><Row :key="item.id" /></li>'],
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
])("reports %s", async (_name, template) => {
  const result = await diagnose(template);
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([RULE_ID]);
  expect(result.diagnostics[0]!.code).toBe("VUE0045");
});

test("reports only the inner list when both levels are unkeyed", async () => {
  const result = await diagnose(
    '<div v-for="row in items"><Cell v-for="cell in row.cells" :cell="cell" /></div>',
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.why).toContain('<Cell v-for="cell in row.cells">');
});

test("skips top-level const array literals that never change", async () => {
  const result = await diagnose(
    '<Row v-for="tab in tabs" :label="tab" />',
    "const tabs = ['Profile', 'Billing'] as const",
  );
  expect(result.diagnostics).toEqual([]);
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

test("suggests a key on the item's id field", async () => {
  const template = '<TodoRow v-for="todo in items" :todo-id="todo.id" />';
  const result = await diagnose(template);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.suggestion).toContain(':key="todo.id"');
  expect(diagnostic!.fix?.kind).toBe("suggestion");
  const [edit] = diagnostic!.fix!.edits;
  expect(edit!.text).toBe(' :key="todo.id"');
  expect(edit!.range.start).toBe(edit!.range.end);
});

test("suggests the id field from the item type", async () => {
  const result = await diagnose(
    '<TodoRow v-for="todo in todos" :todo="todo" />',
    "interface Todo { id: string; title: string }\nconst todos = ref<Todo[]>([])",
  );
  expect(JSON.stringify(result.diagnostics[0])).toContain(':key=\\"todo.id\\"');
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
