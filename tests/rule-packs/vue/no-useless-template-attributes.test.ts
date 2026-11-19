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

test("names the attribute and structural directive without guessing the target", async () => {
  const [diagnostic] = await diagnose(
    `<template v-if="open" id="panel">\n  <section>details</section>\n</template>`,
  );
  expect(diagnostic!.why).toBe(
    "`id` on <template v-if> is dropped. A <template> with v-if renders only its children, so Vue never applies `id`: no rendered element gets `id`, so CSS, anchors, tests and lookups such as document.getElementById that expect it find nothing.",
  );
  expect(diagnostic!.suggestion).toBe(
    "Apply `id` to the intended rendered element or component that supports it.",
  );
});

test("does not prescribe a wrapper when the template renders several nodes", async () => {
  const diagnostics = await diagnose(
    `<table><tbody><template v-for="item in items" class="row"><tr><td>{{ item }}</td></tr><tr><td>-</td></tr></template></tbody></table>\n<p v-if="open" /><template v-else-if="foo" :title="label">Plain text</template>`,
  );
  expect(diagnostics.map((diagnostic) => diagnostic.source)).toEqual([
    'class="row"',
    ':title="label"',
  ]);
  expect(diagnostics[0]!.why).toContain("A <template> with v-for renders only its children");
  for (const diagnostic of diagnostics)
    expect(diagnostic.suggestion).toMatch(
      /intended rendered element or component that supports it/,
    );
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

test("explains dropped listeners and refs and keeps visibility separate from branch selection", async () => {
  const diagnostics = await diagnose(
    `<CoolButton><template #default ref="slotRoot" @click="select"><span>x</span></template></CoolButton>\n<template v-if="ready" v-show="visible"><input /></template><p v-else>Not ready</p>`,
  );
  expect(
    diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.why, diagnostic.suggestion]),
  ).toEqual([
    [
      'ref="slotRoot"',
      "`ref` on <template #default> is dropped. A <template> with #default renders only its children, so Vue never applies `ref`: the template ref is never set and stays null.",
      "Apply `ref` to the intended rendered element or component that supports it.",
    ],
    [
      '@click="select"',
      "`@click` on <template #default> is dropped. A <template> with #default renders only its children, so Vue never applies `@click`: the listener is never attached, so its handler never runs.",
      "Apply `@click` to the intended rendered element or component that supports it.",
    ],
    [
      'v-show="visible"',
      "`v-show` on <template v-if> is dropped. A <template> with v-if renders only its children, so Vue never applies `v-show`: v-show never hides or shows anything here.",
      "Apply `v-show` to the intended rendered element or elements that support it. Keep visibility separate from branch selection so hiding content does not unmount it or select a different branch.",
    ],
  ]);
});

test("explains how to choose compatible targets for bindings and content directives", async () => {
  const diagnostics = await diagnose(`
  <template v-if="open" v-model="value"><div /></template>
  <template v-for="item in items" v-model="item"><input /></template>
  <template v-if="open" v-html="html"><p>old</p></template>
  <template v-if="open" v-text="text"><p>old</p></template>
  <template v-if="open" :id="id"><div v-pre /></template>`);
  expect(diagnostics.map((diagnostic) => diagnostic.suggestion)).toEqual([
    "Bind `v-model` to an intended form control or component that supports it, using a writable expression in that scope.",
    "Bind `v-model` to an intended form control or component that supports it, using a writable expression in that scope.",
    "Apply `v-html` to a compatible rendered element whose content should be replaced, without template children of its own.",
    "Apply `v-text` to a compatible rendered element whose content should be replaced, without template children of its own.",
    "Apply `:id` to the intended rendered element or component that supports it.",
  ]);
});

test("allows keys and caching directives where Vue applies them", async () => {
  const diagnostics = await diagnose(`
  <template v-for="item in items" :key="item.id" v-once><span>{{ item.done }}</span></template>
  <template v-for="item in items" key="static"><span>{{ item.done }}</span></template>
  <template v-for="item in items" v-bind:key="item.id" v-memo="[item.done]"><span>{{ item.done }}</span></template>
  <template v-if="foo" v-for="item in items" :key="item.id" v-memo="[item.done]"><span>{{ item.done }}</span></template>
  <template v-else v-for="item in items" :key="item.id" v-memo="[item.done]"><span>{{ item.done }}</span></template>
  <template v-if="foo" v-once v-cloak><span>{{ revision }}</span></template>`);
  expect(diagnostics).toEqual([]);
});

test("reports authored keys and caching directives Vue ignores on conditional and slot templates", async () => {
  const diagnostics = await diagnose(`
  <template v-if="foo" :key="resetToken" v-memo="[revision]"><span>{{ revision }}</span></template>
  <template v-else-if="bar" key="other" v-once><span>{{ revision }}</span></template>
  <template v-else v-for="item in items" v-once><span>{{ item.done }}</span></template>
  <CoolButton><template #default v-bind:key="resetToken" v-memo="[revision]" v-once><span>{{ revision }}</span></template></CoolButton>
  <CoolButton><template #[item.name] v-for="item in items" :key="item.id" v-memo="[item.done]" v-once><span>{{ item.done }}</span></template></CoolButton>`);
  expect(diagnostics.map((diagnostic) => diagnostic.source)).toEqual([
    ':key="resetToken"',
    'v-memo="[revision]"',
    'key="other"',
    "v-once",
    "v-once",
    'v-bind:key="resetToken"',
    'v-memo="[revision]"',
    "v-once",
    ':key="item.id"',
    'v-memo="[item.done]"',
    "v-once",
  ]);
  expect(diagnostics[0]!.why).toContain("authored key does not control runtime identity");
  expect(diagnostics[0]!.suggestion).toContain("whose identity it should control");
  expect(diagnostics[1]!.why).toContain("does not memoize the children");
  expect(diagnostics[3]!.why).toContain("does not cache the children");
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

test("skips legacy Vue 2 scope attributes and v-pre templates", async () => {
  const diagnostics = await diagnose(`
  <CoolButton><template slot="foo">...</template></CoolButton>
  <CoolButton><template v-if="foo" slot-scope="foo" scope="foo">...</template></CoolButton>
  <template v-pre v-if="foo" id="raw">...</template>`);
  expect(diagnostics).toEqual([]);
});

test("reports static and bound native slot assignments lost on structural templates", async () => {
  const diagnostics = await diagnose(`
  <my-dialog>
    <template v-if="open" slot="header"><h2>{{ title }}</h2></template>
    <template v-else-if="preview" :slot="name"><h2>{{ title }}</h2></template>
    <template v-else v-bind:slot="name"><h2>{{ title }}</h2></template>
  </my-dialog>`);
  expect(diagnostics.map((diagnostic) => diagnostic.source)).toEqual([
    'slot="header"',
    ':slot="name"',
    'v-bind:slot="name"',
  ]);
  for (const diagnostic of diagnostics) {
    expect(diagnostic.why).toContain("no rendered element is assigned to the named native slot");
    expect(diagnostic.suggestion).toContain("rendered element that should be assigned");
  }
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
