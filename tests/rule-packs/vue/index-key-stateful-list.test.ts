import { expect, test } from "vite-plus/test";
import { runVueSfcRuleFixture } from "../../rule-fixtures.ts";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { noIndexKeyOnStatefulList } from "../../../src/rule-packs/vue/rules/vue/no-index-key-on-stateful-list.ts";

const RULE_ID = "vue/template/no-index-key-on-stateful-list";

function sfc(template: string, script = "const items = ref([])") {
  return `<script setup lang="ts">\n${script}\n</script>\n<template>\n${template}\n</template>`;
}

test.each([
  ["a component", '<TodoRow v-for="(item, index) in items" :key="index" :item="item" />'],
  ["a kebab-case component", '<todo-row v-for="(item, i) in items" :key="i" :item="item" />'],
  ["a dynamic component", '<component :is="item.cmp" v-for="(item, idx) in items" :key="idx" />'],
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
  const result = await runVueSfcRuleFixture(noIndexKeyOnStatefulList, sfc(template));
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
  const result = await runVueSfcRuleFixture(noIndexKeyOnStatefulList, sfc(template));
  expect(result.diagnostics).toEqual([]);
});

test("skips top-level const array literals that never change", async () => {
  const result = await runVueSfcRuleFixture(
    noIndexKeyOnStatefulList,
    sfc(
      '<Tab v-for="(tab, i) in tabs" :key="i" :label="tab" />',
      "const tabs = ['Profile', 'Billing'] as const",
    ),
  );
  expect(result.diagnostics).toEqual([]);
});

test("still reports a reactive array binding", async () => {
  const result = await runVueSfcRuleFixture(
    noIndexKeyOnStatefulList,
    sfc('<Tab v-for="(tab, i) in tabs" :key="i" :label="tab" />', "const tabs = ref(['a'])"),
  );
  expect(result.diagnostics).toHaveLength(1);
});

test("names the failure mode and a stable key in the diagnostic", async () => {
  const result = await runVueSfcRuleFixture(
    noIndexKeyOnStatefulList,
    sfc('<TodoRow v-for="(todo, index) in items" :key="index" :todo="todo" />'),
  );
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.why).toContain('v-for index "index" on <TodoRow>');
  expect(diagnostic!.why).toContain("component instance");
  expect(diagnostic!.message ?? "").not.toBe("");
  expect(JSON.stringify(diagnostic)).toContain(':key=\\"todo.id\\"');
});

test("is part of the recommended preset", () => {
  expect(vueRulePack.presets.recommended).toContain(RULE_ID);
});
