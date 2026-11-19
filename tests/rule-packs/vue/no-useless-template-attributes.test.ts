import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import { noUselessTemplateAttributes } from "../../../src/rule-packs/vue/rules/vue/no-useless-template-attributes.ts";

const RULE_ID = "vue/template/no-useless-template-attributes";

const project = createProjectFixture({ framework: "vue" });
afterAll(() => project.dispose());

function sfc(template: string) {
  return `<script setup lang="ts">\nconst foo = ref(true)\n</script>\n<template>\n${template}\n</template>`;
}

async function diagnose(template: string) {
  const source = sfc(template);
  const result = await project.run({
    rule: noUselessTemplateAttributes,
    files: { "app.vue": source },
  });
  return result.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    source: source.slice(diagnostic.range!.start, diagnostic.range!.end),
  }));
}

test("reports attributes and directives on structural templates, as upstream does", async () => {
  const diagnostics = await diagnose(`
  <template v-if="foo">...</template>
  <template v-else-if="foo">...</template>
  <template v-else>...</template>
  <template v-for="i in foo" :key="i">...</template>
  <CoolButton><template v-slot:foo>...</template></CoolButton>

  <template v-if="foo" class="heading">...</template>
  <template v-for="i in foo" :bar="i">...</template>
  <CoolButton><template v-slot:foo="foo" ref="input">...</template></CoolButton>
  <template v-if="foo" @click="click">...</template>

  <template class="heading">...</template>
  <template :bar="i">...</template>
  <template ref="input">...</template>
  <template @click="click">...</template>`);

  expect(diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.range!.line])).toEqual([
    ['class="heading"', 12],
    [':bar="i"', 13],
    ['ref="input"', 14],
    ['@click="click"', 15],
  ]);
  for (const diagnostic of diagnostics) {
    expect(diagnostic.ruleId).toBe(RULE_ID);
    expect(diagnostic.code).toBe("VUE0044");
    expect(diagnostic.confidence).toBe("proven");
    expect(diagnostic.fix).toBeUndefined();
  }
});

test("names the attribute, the structural directive and the only child it belongs on", async () => {
  const [diagnostic] = await diagnose(
    `<template v-if="open" id="panel">\n  <section>details</section>\n</template>`,
  );
  expect(diagnostic!.why).toBe(
    "`id` on <template v-if> is dropped. A <template> with v-if renders only its children, so Vue never applies `id` and gives no warning: no rendered element gets `id`, so CSS, anchors, tests and lookups such as document.getElementById that expect it find nothing.",
  );
  expect(diagnostic!.suggestion).toBe(
    "Move `id` onto <section>, the only element inside this <template>.",
  );
});

test("suggests a wrapper when the template renders several nodes", async () => {
  const diagnostics = await diagnose(
    `<ul><template v-for="item in items" class="row"><li>{{ item }}</li><li>-</li></template></ul>\n<template v-else-if="foo" :title="label">Plain text</template>`,
  );
  expect(diagnostics.map((diagnostic) => diagnostic.source)).toEqual([
    'class="row"',
    ':title="label"',
  ]);
  expect(diagnostics[0]!.why).toContain("A <template> with v-for renders only its children");
  for (const diagnostic of diagnostics)
    expect(diagnostic.suggestion).toMatch(/^Wrap the children of this <template> in an element/);
});

test("reports every dropped attribute and directive on its own range", async () => {
  const diagnostics = await diagnose(
    `<template v-if="foo" id="panel" :aria-label="label" v-bind="attrs" v-on="listeners" :[name]="value" v-html="html" v-text="text" v-model="value" v-focus style="color: red"><input></template>`,
  );
  expect(diagnostics.map((diagnostic) => diagnostic.source)).toEqual([
    'id="panel"',
    ':aria-label="label"',
    'v-bind="attrs"',
    'v-on="listeners"',
    ':[name]="value"',
    'v-html="html"',
    'v-text="text"',
    'v-model="value"',
    "v-focus",
    'style="color: red"',
  ]);
  expect(diagnostics.find((diagnostic) => diagnostic.source === "v-focus")!.why).toContain(
    "the `v-focus` directive's hooks never run.",
  );
});

test("explains the effect of a dropped listener, ref and v-show", async () => {
  const diagnostics = await diagnose(
    `<CoolButton><template #default ref="slotRoot" @click="select"><span>x</span></template></CoolButton>\n<template v-if="ready" v-show="visible"><p>a</p><p>b</p></template>`,
  );
  expect(
    diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.why, diagnostic.suggestion]),
  ).toEqual([
    [
      'ref="slotRoot"',
      "`ref` on <template #default> is dropped. A <template> with #default renders only its children, so Vue never applies `ref` and gives no warning: the template ref is never set and stays null.",
      "Move `ref` onto <span>, the only element inside this <template>.",
    ],
    [
      '@click="select"',
      "`@click` on <template #default> is dropped. A <template> with #default renders only its children, so Vue never applies `@click` and gives no warning: the listener is never attached, so its handler never runs.",
      "Move `@click` onto <span>, the only element inside this <template>.",
    ],
    [
      'v-show="visible"',
      "`v-show` on <template v-if> is dropped. A <template> with v-if renders only its children, so Vue never applies `v-show` and gives no warning: v-show never hides or shows anything here.",
      "Fold the `v-show` condition into v-if, or put `v-show` on each element inside this <template>.",
    ],
  ]);
});

test("allows key, v-memo and v-once, which Vue still reads on a structural template", async () => {
  const diagnostics = await diagnose(`
  <template v-for="item in items" :key="item.id">...</template>
  <template v-for="item in items" key="static">...</template>
  <template v-for="item in items" v-bind:key="item.id" v-memo="[item.done]"><span /></template>
  <template v-if="foo" key="a">...</template>
  <template v-else key="b">...</template>
  <template v-if="foo" v-once><span /></template>`);
  expect(diagnostics).toEqual([]);
});

test("allows attributes on a plain template, which renders a native <template> element", async () => {
  const diagnostics = await diagnose(`
  <template foo="a">...</template>
  <template :foo="a">...</template>
  <template v-unknown="a">...</template>
  <template id="row-template"><tr><td /></tr></template>`);
  expect(diagnostics).toEqual([]);
});

test("allows attributes on elements that carry structural directives", async () => {
  const diagnostics = await diagnose(`
  <div v-if="foo" class="heading">...</div>
  <div v-for="i in foo" :bar="i">...</div>
  <CoolButton v-slot:foo="foo" ref="input">...</CoolButton>
  <div v-if="foo" @click="click">...</div>`);
  expect(diagnostics).toEqual([]);
});

test("skips Vue 2 slot syntax and v-pre templates", async () => {
  const diagnostics = await diagnose(`
  <CoolButton><template slot="foo">...</template></CoolButton>
  <CoolButton><template slot-scope="foo">...</template></CoolButton>
  <CoolButton><template scope="foo">...</template></CoolButton>
  <CoolButton><template v-if="foo" slot="foo" :slot="name">...</template></CoolButton>
  <template v-pre v-if="foo" id="raw">...</template>`);
  expect(diagnostics).toEqual([]);
});

test("skips templates written in another language", async () => {
  const result = await project.run({
    rule: noUselessTemplateAttributes,
    files: {
      "app.vue": `<template lang="pug">\ntemplate(v-if="foo" id="panel")\n  section details\n</template>`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});
