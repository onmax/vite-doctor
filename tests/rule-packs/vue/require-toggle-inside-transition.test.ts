import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { requireToggleInsideTransition } from "../../../src/rule-packs/vue/rules/vue/require-toggle-inside-transition.ts";

const RULE_ID = "vue/template/require-toggle-inside-transition";

const project = createProjectFixture({ framework: "vue" });
afterAll(() => project.dispose());

function sfc(template: string) {
  return `<template>${template}</template>`;
}

/** Runs each template as its own SFC and returns the reported start tags by template. */
async function reported(templates: string[]) {
  const files = Object.fromEntries(templates.map((template, i) => [`T${i}.vue`, sfc(template)]));
  const result = await project.run({ rule: requireToggleInsideTransition, files });
  return templates.map((template, i) =>
    result.diagnostics
      .filter((diagnostic) => diagnostic.file.endsWith(`T${i}.vue`))
      .map((diagnostic) => sfc(template).slice(diagnostic.range!.start, diagnostic.range!.end)),
  );
}

test("reports a static native child, on its start tag (upstream invalid cases)", async () => {
  const cases: Array<[string, string]> = [
    ["<transition><div /></transition>", "<div />"],
    ["<Transition><div /></Transition>", "<div />"],
    ["<transition><div /><div /></transition>", "<div />"],
    ['<transition><div v-for="e in list" /></transition>', '<div v-for="e in list" />'],
    ['<svg height="100" width="100"><transition><circle /></transition></svg> ', "<circle />"],
    [
      '<transition><template v-for="e in list"><div /></template></transition>',
      '<template v-for="e in list">',
    ],
    ["<Transition>  <div /></Transition>", "<div />"],
    ['<transition :appear="false"><div /></transition>', "<div />"],
    ['<transition @appear="isLoaded"><div /></transition>', "<div />"],
  ];
  expect(await reported(cases.map(([template]) => template))).toEqual(
    cases.map(([, tag]) => [tag]),
  );
}, 30_000);

test("reports children that stay mounted for reasons upstream misses or keeps", async () => {
  const cases: Array<[string, string]> = [
    // A static key never changes, so it never replaces the element.
    ['<Transition><p key="note">Saved</p></Transition>', '<p key="note">'],
    [
      '<Transition name="fade">\n  <!-- toast -->\n  <div class="toast">Hi</div>\n</Transition>',
      '<div class="toast">',
    ],
    [
      '<Transition><template #default><div class="panel" /></template></Transition>',
      '<div class="panel" />',
    ],
    [
      '<Transition><input v-model="name" :class="cls" @input="save"></Transition>',
      '<input v-model="name" :class="cls" @input="save">',
    ],
    ['<Transition v-if="ready"><section /></Transition>', "<section />"],
  ];
  expect(await reported(cases.map(([template]) => template))).toEqual(
    cases.map(([, tag]) => [tag]),
  );
}, 30_000);

test("names the child and the fix in the Diagnostic", async () => {
  const result = await project.run({
    rule: requireToggleInsideTransition,
    files: {
      "Toast.vue": sfc('<Transition name="fade"><div class="toast">Hi</div></Transition>'),
      "List.vue": sfc('<transition><li v-for="item in items">{{ item.text }}</li></transition>'),
    },
  });
  const byFile = Object.fromEntries(
    result.diagnostics.map((diagnostic) => [diagnostic.file.split("/").at(-1), diagnostic]),
  );
  expect(byFile["Toast.vue"]).toMatchObject({
    code: "VUE0046",
    ruleId: RULE_ID,
    severity: "warn",
    confidence: "proven",
    why: "<div> inside <Transition> has no v-if, v-show or bound :key, so it never enters or leaves and the transition never runs. Its enter and leave classes and CSS never apply, and without appear the first render does not animate either.",
    suggestion:
      "Add v-if or v-show to <div> so it enters and leaves, bind a :key that changes when the content should animate, add appear to <Transition> if the goal is an enter animation on mount, or remove the <Transition>.",
  });
  expect(byFile["Toast.vue"]!.fix).toBeUndefined();
  expect(byFile["List.vue"]).toMatchObject({
    why: "<li> inside <transition> repeats with v-for instead of toggling. <transition> animates a single child entering or leaving, so this list never animates. Once the list has more than one item, Vue warns that <transition> can only be used on a single element and renders only the first item.",
    suggestion:
      "Replace <transition> with <TransitionGroup> to animate items of the v-for list, or move the v-for outside <transition> and toggle each item with v-if.",
  });
}, 30_000);

test("allows toggled children, appear and bound keys (upstream valid cases)", async () => {
  const valid = [
    "",
    '<transition><div v-if="show" /></transition>',
    '<transition><div v-show="show" /></transition>',
    '<Transition><div v-if="show" /></Transition>',
    '<Transition><div v-show="show" /></Transition>',
    "<Transition><MyComp /></Transition>",
    '<Transition><component :is="component" /></Transition>',
    '<Transition><div :is="component" /></Transition>',
    '<svg height="100" width="100"><transition><circle v-if="show" /></transition></svg> ',
    '<svg height="100" width="100"><transition><MyComponent /></transition></svg> ',
    '<transition><template v-if="show"><div /></template></transition>',
    "<transition><slot /></transition>",
    '<transition><div :key="k" /></transition>',
    "<transition appear><div /></transition>",
    '<transition :appear="foo"><div /></transition>',
    '<transition :appear="true"><div /></transition>',
  ];
  expect((await reported(valid)).flat()).toEqual([]);
}, 30_000);

test("allows v-if/v-else chains and keyed swaps", async () => {
  const valid = [
    '<Transition mode="out-in"><p v-if="saved">Saved</p><p v-else-if="saving">Saving</p><p v-else>Edit</p></Transition>',
    '<Transition mode="out-in"><img v-bind:key="src" :src="src"></Transition>',
    "<Transition><template v-else><div /></template></Transition>",
    '<Transition><TransitionGroup><li v-for="i in list" :key="i" /></TransitionGroup></Transition>',
    '<TransitionGroup tag="ul"><li /></TransitionGroup>',
    '<transition-group tag="ul"><li /></transition-group>',
  ];
  expect((await reported(valid)).flat()).toEqual([]);
}, 30_000);

test("treats children it cannot read in full as unknown", async () => {
  const unknown = [
    // Components may toggle their own root.
    '<Transition><KeepAlive><component :is="view" /></KeepAlive></Transition>',
    "<Transition><RouterView /></Transition>",
    "<Transition><NuxtPage /></Transition>",
    "<transition><router-view /></transition>",
    "<Transition><my-widget /></Transition>",
    '<Transition><div is="vue:Panel" /></Transition>',
    '<Transition><slot name="panel" /></Transition>',
    // An object spread on the child may carry a key, on the Transition it may carry appear.
    '<Transition><div v-bind="attrs" /></Transition>',
    '<Transition v-bind="transitionProps"><div /></Transition>',
    '<Transition><div :[name]="value" /></Transition>',
    // A custom directive can drive Transition hooks the way v-show does (upstream invalid
    // unless listed in additionalDirectives).
    '<transition><dialog v-dialog="show" /></transition>',
    '<transition><div v-custom="show" /></transition>',
    // No element child.
    "<Transition></Transition>",
    "<Transition>Loading</Transition>",
    "<Transition><!-- nothing yet --></Transition>",
    "<Transition>{{ label }}</Transition>",
    // Named slots are not rendered by Transition.
    "<Transition><template #extra><div /></template></Transition>",
  ];
  expect((await reported(unknown)).flat()).toEqual([]);
}, 30_000);

test("is in the Recommended Preset", () => {
  expect(vueRulePack.presets?.recommended).toContain(RULE_ID);
});
