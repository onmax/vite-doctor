import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { requireExplicitEmits } from "../../../src/rule-packs/vue/rules/vue/require-explicit-emits.ts";

const RULE_ID = "vue/attrs/require-explicit-emits";

const project = createProjectFixture({ framework: "vue" });
afterAll(() => project.dispose());

function diagnose(source: string) {
  return project.run({ rule: requireExplicitEmits, files: { "Comp.vue": source } });
}

async function reported(source: string) {
  const result = await diagnose(source);
  return result.diagnostics.filter((diagnostic) => diagnostic.ruleId === RULE_ID);
}

test.each([
  [
    "a template-only component",
    `<template>\n  <button @click="$emit('click', id)">x</button>\n</template>`,
  ],
  [
    "an Options API component with other emits",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  emits: ['welcome']\n}\n</script>`,
  ],
  [
    "an Options API emits object",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  emits: {welcome(){}}\n}\n</script>`,
  ],
  [
    "a defineComponent() options object",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script lang="ts">\nimport { defineComponent } from 'vue'\nexport default defineComponent({ name: 'Btn', props: {} })\n</script>`,
  ],
  [
    "defineEmits with a call signature for another event",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\ndefineEmits<{\n  (e: 'foo'): void\n}>()\n</script>`,
  ],
  [
    "defineEmits with a function type for another event",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\ndefineEmits<(e: 'foo') => void>()\n</script>`,
  ],
  [
    "defineEmits with a named-tuple type for another event",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\ntype Emits = { foo: [] }\ndefineEmits<Emits>()\n</script>`,
  ],
  [
    "an empty script setup",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup>\n</script>`,
  ],
  [
    "defineModel without a matching event",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\ndefineModel<string>()\n</script>`,
  ],
  [
    "a descendant handler",
    `<template>\n  <div class="card">\n    <button @click="$emit('click', 1)">x</button>\n  </div>\n</template>`,
  ],
  [
    "a template literal event name",
    '<template>\n  <button @click="$emit(`click`)">x</button>\n</template>',
  ],
  [
    "a capitalized event name",
    `<template>\n  <button @click="$emit('Click')">x</button>\n</template>`,
  ],
  [
    "a multi-statement handler",
    `<template>\n  <button @click="track(); $emit('click', 1)">x</button>\n</template>`,
  ],
  [
    "a non-bubbling event on the root",
    `<template>\n  <input @focus="$emit('focus', 1)">\n</template>`,
  ],
  [
    "a change emitted from an inner input",
    `<template>\n  <label>Name <input @input="$emit('change', $event.target.value)"></label>\n</template>`,
  ],
  [
    "an image error on the root",
    `<template>\n  <img :src="src" @error="$emit('error')">\n</template>`,
  ],
  [
    "a root with v-if",
    `<template>\n  <!-- trigger -->\n  <button v-if="visible" @click="$emit('click')">x</button>\n</template>`,
  ],
])("reports an undeclared native emit in %s", async (_, source) => {
  const diagnostics = await reported(source);
  expect(diagnostics).toHaveLength(1);
  const [diagnostic] = diagnostics;
  expect(diagnostic!.code).toBe("VUE0047");
  expect(diagnostic!.severity).toBe("warn");
  expect(diagnostic!.confidence).toBe("proven");
  expect(source.slice(diagnostic!.range!.start, diagnostic!.range!.end)).toMatch(
    /^['"`][A-Za-z]+['"`]$/,
  );
});

test.each([
  [
    "Options API emits",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  emits: ['click']\n}\n</script>`,
  ],
  [
    "quoted Options API emits",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  'emits': ['click']\n}\n</script>`,
  ],
  [
    "an Options API emits object",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  emits: {click:null}\n}\n</script>`,
  ],
  [
    "defineEmits array",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup>\ndefineEmits(['click'])\n</script>`,
  ],
  [
    "defineEmits object",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup>\ndefineEmits({click:null})\n</script>`,
  ],
  [
    "defineEmits call signature",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\ndefineEmits<{\n  (e: 'click'): void\n}>()\n</script>`,
  ],
  [
    "defineEmits function type",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\ndefineEmits<(e: 'click' | 'keydown') => void>()\n</script>`,
  ],
  [
    "defineEmits named-tuple shorthand",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\nconst emit = defineEmits<{ click: [id: number] }>()\n</script>`,
  ],
  [
    "defineEmits interface",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\ninterface Emits { (e: 'click'): void }\ndefineEmits<Emits>()\n</script>`,
  ],
  [
    "defineEmits with a kebab declaration",
    `<template>\n  <div @click="$emit('Click')"/>\n</template>\n<script setup>\ndefineEmits(['click'])\n</script>`,
  ],
  [
    "an onClick prop",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  props: ['onClick']\n}\n</script>`,
  ],
  [
    "an onClick type prop",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\nwithDefaults(defineProps<{ onClick?: (id: number) => void }>(), {})\n</script>`,
  ],
  [
    "defineOptions inheritAttrs false",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script setup>\ndefineOptions({ inheritAttrs: false })\n</script>`,
  ],
  [
    "Options API inheritAttrs false",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default { inheritAttrs: false }\n</script>`,
  ],
])("allows an emit declared through %s", async (_, source) => {
  expect(await reported(source)).toHaveLength(0);
});

test.each([
  [
    "emits it cannot read",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  emits: unknown\n}\n</script>`,
  ],
  [
    "defineEmits it cannot read",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup>\nconst emit = defineEmits(unknown)\n</script>`,
  ],
  [
    "a spread emits object",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  emits: {...foo}\n}\n</script>`,
  ],
  [
    "an identifier in emits",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  emits: [foo]\n}\n</script>`,
  ],
  [
    "a spread emits array",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  emits: [...foo]\n}\n</script>`,
  ],
  [
    "an imported emits type",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\nimport type { Emits } from './types'\ndefineEmits<Emits>()\n</script>`,
  ],
  [
    "props it cannot read",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  props: unknown\n}\n</script>`,
  ],
  [
    "defineProps it cannot read",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup>\ndefineProps(unknown)\n</script>`,
  ],
  [
    "a spread props array",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  props: [...foo],\n}\n</script>`,
  ],
  [
    "mixins",
    `<template>\n  <button @click="$emit('click')"/>\n</template>\n<script>\nimport sampleMixin from './sampleMixin'\nexport default {\n  mixins: [sampleMixin]\n}\n</script>`,
  ],
  [
    "a spread options object",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script>\nexport default {\n  ...foo\n}\n</script>`,
  ],
  [
    "an exported identifier",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script>\nconst Foo = {}\nexport default Foo\n</script>`,
  ],
  [
    "inheritAttrs it cannot read",
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup>\ndefineOptions({ inheritAttrs: inherit })\n</script>`,
  ],
])("stays silent on %s", async (_, source) => {
  expect(await reported(source)).toHaveLength(0);
});

// Upstream reports every undeclared emit. These do not fall through as a native listener that fires.
test.each([
  [
    "a custom event name",
    `<template>\n  <div @click="$emit('foo')"/>\n</template>\n<script>\nexport default {\n  emits: ['welcome']\n}\n</script>`,
  ],
  [
    "a custom event in script setup",
    `<template>\n  <div @click="$emit('bar')"/>\n</template>\n<script setup>\ndefineEmits(['foo'])\n</script>`,
  ],
  [
    "select, a common custom event",
    `<template>\n  <li @click="$emit('select', item)">{{ item }}</li>\n</template>`,
  ],
  [
    "an update event",
    `<template>\n  <input @input="$emit('update:modelValue', $event.target.value)">\n</template>`,
  ],
  [
    "an unknown event name",
    `<template>\n  <div @click="$emit(foo)"/>\n  <div @click="$emit()"/>\n</template>`,
  ],
  [
    "script emit() from defineEmits",
    `<template>\n  <div @click="emit('click')"/>\n</template>\n<script setup lang="ts">\nconst emit = defineEmits<(e: 'foo') => void>()\n</script>`,
  ],
  [
    "script-side this.$emit",
    `<template>\n  <div @click="onClick"/>\n</template>\n<script>\nexport default {\n  emits: ['welcome'],\n  methods: { onClick() { this.$emit('click') } }\n}\n</script>`,
  ],
  [
    "a multi-root template",
    `<template>\n  <button @click="$emit('click')">x</button>\n  <span />\n</template>`,
  ],
  ["a component root", `<template>\n  <MyButton @click="$emit('click')">x</MyButton>\n</template>`],
  ["a slot root", `<template>\n  <slot :emit="() => $emit('click')" />\n</template>`],
  [
    "a plain template root",
    `<template>\n  <template><button @click="$emit('click')">x</button></template>\n</template>`,
  ],
  [
    "a v-for root",
    `<template>\n  <button v-for="item in items" @click="$emit('click', item)">x</button>\n</template>`,
  ],
  [
    "a descendant handler with .stop",
    `<template>\n  <div>\n    <button @click.stop="$emit('click', 1)">x</button>\n  </div>\n</template>`,
  ],
  [
    "a descendant that stops propagation",
    `<template>\n  <div>\n    <button @click="$event.stopPropagation(); $emit('click', 1)">x</button>\n  </div>\n</template>`,
  ],
  [
    "a non-bubbling event on a descendant",
    `<template>\n  <div>\n    <input @focus="$emit('focus', 1)">\n  </div>\n</template>`,
  ],
  [
    "keyboard events on an element that cannot take focus",
    `<template>\n  <div @click="$emit('keydown')">x</div>\n</template>`,
  ],
  [
    "change without a form control",
    `<template>\n  <div @click="$emit('change', 1)">x</div>\n</template>`,
  ],
  [
    "a form control inside a child component",
    `<template>\n  <div>\n    <MyInput @update="$emit('change', $event)" />\n  </div>\n</template>`,
  ],
  ["submit without a form", `<template>\n  <div @click="$emit('submit')">x</div>\n</template>`],
])("allows %s", async (_, source) => {
  expect(await reported(source)).toHaveLength(0);
});

test("explains the double call and suggests appending to defineEmits", async () => {
  const source = `<script setup lang="ts">\ndefineEmits(["close"])\n</script>\n<template>\n  <button type="button" @click="$emit('click', id)">Open</button>\n</template>`;
  const [diagnostic] = await reported(source);
  expect(diagnostic!.why).toBe(
    `$emit('click') runs in a @click handler on the root <button> itself. "click" is not declared in defineEmits or emits, so Vue treats the parent's @click listener as a fallthrough attribute and also binds it as a native click listener on the root <button>. One click runs the parent's handler twice: once from $emit with its payload, and once from the native click with the DOM event object.`,
  );
  expect(diagnostic!.suggestion).toBe(
    `Add it to defineEmits: \`defineEmits(["close", 'click'])\`. The parent's @click then only receives the emitted event. If the parent should keep a native click listener on <button>, emit an event whose name is not a native DOM event instead.`,
  );
  expect(diagnostic!.fix?.kind).toBe("suggestion");
  const edit = diagnostic!.fix!.edits[0]!;
  const fixed = source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end);
  expect(fixed).toContain(`defineEmits(["close", "click"])`);
});

test("names the bubbling path for a descendant handler", async () => {
  const [diagnostic] = await reported(
    `<template>\n  <div class="card">\n    <button @click="$emit('click', 1)">x</button>\n  </div>\n</template>`,
  );
  expect(diagnostic!.why).toContain(
    "runs in a @click handler on <button>, and the native event bubbles to <div>.",
  );
  expect(diagnostic!.suggestion).toContain(
    "Declare it in a <script setup> block: `defineEmits(['click'])`.",
  );
  expect(diagnostic!.fix).toBeFalsy();
});

test("explains an emit outside a handler for the same event", async () => {
  const [diagnostic] = await reported(
    `<template>\n  <label>Name <input @input="$emit('change', $event.target.value)"></label>\n</template>\n<script>\nexport default { emits: ['input'] }\n</script>`,
  );
  expect(diagnostic!.why).toBe(
    `The template calls $emit('change'). "change" is not declared in defineEmits or emits, so Vue treats the parent's @change listener as a fallthrough attribute and also binds it as a native change listener on the root <label>. <label> contains a form control that fires them and they bubble, so the parent's handler runs twice: for each $emit('change') with its payload, and again for each native change with the DOM event object.`,
  );
  expect(diagnostic!.suggestion).toContain(
    "Add it to the emits option: `emits: ['input', 'change']`.",
  );
  expect(diagnostic!.fix).toBeFalsy();
});

test("offers no edit for a type-based defineEmits", async () => {
  const [diagnostic] = await reported(
    `<template>\n  <div @click="$emit('click')"/>\n</template>\n<script setup lang="ts">\ndefineEmits<{ close: [] }>()\n</script>`,
  );
  expect(diagnostic!.suggestion).toContain("to the defineEmits type");
  expect(diagnostic!.fix).toBeFalsy();
});

test("reports each undeclared event once", async () => {
  const diagnostics = await reported(
    `<template>\n  <form @submit.prevent="$emit('submit', values)">\n    <input @keydown.enter="$emit('keydown')">\n    <button @click="$emit('click')">a</button>\n    <button @click="$emit('click')">b</button>\n  </form>\n</template>`,
  );
  expect(diagnostics.map((diagnostic) => diagnostic.why.match(/"(\w+)"/)![1])).toEqual([
    "submit",
    "keydown",
    "click",
  ]);
});

test("is in the Strict Preset only", () => {
  expect(vueRulePack.presets.strict).toContain(RULE_ID);
  expect(vueRulePack.presets.recommended).not.toContain(RULE_ID);
});
