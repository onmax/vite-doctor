import { compileScript, parse } from "@vue/compiler-sfc";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { requireExplicitEmits } from "../../../src/rule-packs/vue/rules/vue/require-explicit-emits.ts";

const RULE_ID = "vue/attrs/require-explicit-emits";

const project = createProjectFixture({ framework: "vue" });
afterAll(() => project.dispose());

function diagnose(source: string) {
  return project.run({ rule: requireExplicitEmits, files: { "Comp.vue": source } });
}

function applyEdits(
  source: string,
  edits: Array<{ range: { start: number; end: number }; text: string }>,
) {
  return [...edits]
    .sort((left, right) => right.range.start - left.range.start)
    .reduce(
      (text, edit) => text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end),
      source,
    );
}

/** The runtime emits Vue's compiler generates for the SFC; throws on compiler errors. */
function compiledEmits(source: string): string[] {
  const { descriptor, errors } = parse(source);
  if (errors.length > 0) throw errors[0];
  const { content } = compileScript(descriptor, { id: "test" });
  const emits = /emits: ([^\n]*)/.exec(content)?.[1] ?? "";
  return [...emits.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);
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
    "a keydown that bubbles from an inner input",
    `<template>\n  <div>\n    <input @keydown="$emit('keydown', $event.target.value)">\n  </div>\n</template>`,
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
    `$emit('click') runs in a @click handler on the root <button>. "click" is not declared in defineEmits or emits, so Vue treats the parent's @click listener as a fallthrough attribute and also binds it as a native click listener on the root <button>. Each click that runs this $emit runs the parent's handler twice: once from $emit with its payload, and once from the native click with the DOM event object.`,
  );
  expect(diagnostic!.suggestion).toBe(
    `Add it to defineEmits: \`defineEmits(["close", "click"])\`. The parent's @click then only receives the emitted event. If the parent should keep a native click listener on <button>, emit an event whose name is not a native DOM event instead.`,
  );
  expect(diagnostic!.fix?.kind).toBe("suggestion");
  const fixed = applyEdits(source, diagnostic!.fix!.edits);
  expect(fixed).toContain(`defineEmits(["close", "click"])`);
  expect(compiledEmits(fixed)).toEqual(["close", "click"]);
});

test("names the bubbling path for a descendant handler", async () => {
  const [diagnostic] = await reported(
    `<template>\n  <div class="card">\n    <button @click="$emit('click', 1)">x</button>\n  </div>\n</template>`,
  );
  expect(diagnostic!.why).toContain(
    "runs in a @click handler on <button>, and nothing between it and the root <div> stops the native click from bubbling there.",
  );
  expect(diagnostic!.suggestion).toContain(
    "Declare it in a <script setup> block: `defineEmits(['click'])`.",
  );
  expect(diagnostic!.fix).toBeFalsy();
});

test("suggests adding to the emits option the component actually uses", async () => {
  const [diagnostic] = await reported(
    `<template>\n  <button @click="$emit('click')">x</button>\n</template>\n<script>\nexport default { emits: ['input'] }\n</script>\n<script setup>\nconst a = 1\n</script>`,
  );
  expect(diagnostic!.suggestion).toContain(
    "Add it to the emits option: `emits: ['input', 'click']`.",
  );
  expect(diagnostic!.fix).toBeFalsy();
});

// Vue merges `<script setup>` declarations into the normal script's options with
// Object.assign(normal, defineOptions, { props, emits, setup }), so setup-generated options win.
describe("two script blocks", () => {
  test.each([
    [
      "setup defineEmits after a normal emits option",
      `<script setup>\ndefineEmits(['click'])\n</script>\n<script>\nexport default { emits: ['other'] }\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "setup defineEmits before a normal emits option",
      `<script>\nexport default { emits: ['other'] }\n</script>\n<script setup>\ndefineEmits(['click'])\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "normal emits with a setup block that declares none",
      `<script>\nexport default { emits: ['click'] }\n</script>\n<script setup>\nconst a = 1\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "defineOptions inheritAttrs false before a normal inheritAttrs true",
      `<script setup>\ndefineOptions({ inheritAttrs: false })\n</script>\n<script>\nexport default { inheritAttrs: true }\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "defineOptions inheritAttrs false after a normal inheritAttrs true",
      `<script>\nexport default { inheritAttrs: true }\n</script>\n<script setup>\ndefineOptions({ inheritAttrs: false })\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "normal inheritAttrs false with a setup block",
      `<script>\nexport default { inheritAttrs: false }\n</script>\n<script setup>\nconst a = 1\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "a normal script loaded from src",
      `<script src="./options.js"></script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
  ])("stays silent on %s", async (_, source) => {
    expect(await reported(source)).toHaveLength(0);
  });

  test.each([
    [
      "setup defineModel() replacing a normal emits option",
      `<script>\nexport default { emits: ['click'] }\n</script>\n<script setup>\ndefineModel()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "setup defineProps() replacing a normal onClick prop",
      `<script>\nexport default { props: ['onClick'] }\n</script>\n<script setup>\ndefineProps({ label: String })\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "a defineEmits function in a normal script, which is not the macro",
      `<script>\nfunction defineEmits() {}\ndefineEmits(['click'])\nexport default {}\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
  ])("reports %s", async (_, source) => {
    expect(await reported(source)).toHaveLength(1);
  });

  test("tells a defineModel() component to add defineEmits", async () => {
    const source = `<script>\nexport default { emits: ['click'] }\n</script>\n<script setup>\ndefineModel()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`;
    const [diagnostic] = await reported(source);
    expect(diagnostic!.suggestion).toContain("Add `defineEmits(['click'])` to <script setup>.");
    expect(
      compiledEmits(source.replace("defineModel()", "defineModel()\ndefineEmits(['click'])")),
    ).toContain("click");
  });
});

describe("the DOM path to the root", () => {
  test.each([
    [
      "a case-sensitive native listener for Click rather than click",
      `<script setup>defineEmits(['other'])</script>\n<template>\n  <button @Click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "an intermediate .stop",
      `<template>\n  <div>\n    <div @click.stop>\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "an intermediate .capture.stop",
      `<template>\n  <div>\n    <div @click.capture.stop>\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "a root capture listener that stops the event before it reaches the emitter",
      `<template>\n  <div @clickCapture.stop>\n    <button @click="$emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      "an intermediate method handler",
      `<template>\n  <div>\n    <div @click="onClick">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "an intermediate handler with an event parameter",
      `<template>\n  <div>\n    <div @click="(event) => track(event)">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "an intermediate onClick binding",
      `<template>\n  <div>\n    <div :onClick="handler">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    ...["on:click", "onclick"].map((key) => [
      `an intermediate ${key} binding`,
      `<template>\n  <div>\n    <div :${key}="handler">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ]),
    [
      "an intermediate click listener with a literal Once suffix and .stop",
      `<template>\n  <div>\n    <div @clickOnce.stop>\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "an intermediate object v-on",
      `<template>\n  <div>\n    <div v-on="handlers">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "an intermediate object v-bind",
      `<template>\n  <div>\n    <div v-bind="attrs">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "an intermediate dynamic v-on",
      `<template>\n  <div>\n    <div @[name]="handler">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "a template ref that script can add a listener to",
      `<template>\n  <div>\n    <div ref="box">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "a template ref on the emitter",
      `<template>\n  <div>\n    <button ref="button" @click="$emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      "a custom directive on the path",
      `<template>\n  <div>\n    <button v-tooltip="hint" @click="$emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      "a custom directive on the root",
      `<template>\n  <button v-click-outside="close" @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "the emitter calling stopPropagation behind a condition",
      `<template>\n  <div>\n    <button @click="if (stop) $event.stopPropagation(); $emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      "the emitter setting cancelBubble",
      `<template>\n  <div>\n    <button @click="$event.cancelBubble = true; $emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      "the emitter passing the event to the parent",
      `<template>\n  <div>\n    <button @click="$emit('click', $event)">x</button>\n  </div>\n</template>`,
    ],
    [
      "the emitter passing the event to a function",
      `<template>\n  <button @click="track($event); $emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "a root handler that passes the event on",
      `<template>\n  <div @click="onClick">\n    <button @click="$emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      "an emitter that listens in the capture phase",
      `<template>\n  <div>\n    <div @click.capture="$emit('click', 1)">\n      <button @click.stop>x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "a .right click, which listens for contextmenu",
      `<template>\n  <div>\n    <button @click.right="$emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      "a focus handler inside a focusable root",
      `<template>\n  <div tabindex="-1">\n    <input @focus="$emit('focus', 1)">\n  </div>\n</template>`,
    ],
    [
      "a mouseenter handler inside the root",
      `<template>\n  <div>\n    <span @mouseenter="$emit('mouseenter')">x</span>\n  </div>\n</template>`,
    ],
    [
      "an emit in a handler for another event",
      `<template>\n  <label>Name <input @input="$emit('change', $event.target.value)"></label>\n</template>`,
    ],
    [
      "an emit outside a handler",
      `<template>\n  <button>{{ $emit('click') }}</button>\n</template>`,
    ],
  ])("stays silent on %s", async (_, source) => {
    expect(await reported(source)).toHaveLength(0);
  });

  test.each([
    [
      "an intermediate .stop for Click rather than click",
      `<template>\n  <div>\n    <div @Click.stop>\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "an intermediate .prevent, which does not stop propagation",
      `<template>\n  <div>\n    <div @click.prevent>\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "an intermediate .self handler Doctor can read",
      `<template>\n  <div>\n    <div @click.self="open = !open">\n      <button @click="$emit('click', 1)">x</button>\n    </div>\n  </div>\n</template>`,
    ],
    [
      "the emitter with .self and .prevent",
      `<template>\n  <div>\n    <button @click.self.prevent="$emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      ".stop on the root, which does not stop the root's own listeners",
      `<template>\n  <button @click.stop="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "a handler that only reads event properties",
      `<template>\n  <div>\n    <input @input="$emit('input', $event.target.value)">\n  </div>\n</template>`,
    ],
    [
      "an emitter inside v-if and Transition",
      `<template>\n  <div>\n    <Transition>\n      <button v-if="open" @click="$emit('click', 1)">x</button>\n    </Transition>\n  </div>\n</template>`,
    ],
    [
      "a root ref, which cannot run before Vue's root listeners",
      `<template>\n  <button ref="button" @click="$emit('click', 1)">x</button>\n</template>`,
    ],
  ])("reports %s", async (_, source) => {
    expect(await reported(source)).toHaveLength(1);
  });
});

describe("a shadowed $emit", () => {
  test.each([
    [
      "a script setup const",
      `<script setup>\nconst $emit = () => {}\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "a script setup import",
      `<script setup>\nimport { $emit } from './bus'\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "a normal script binding next to script setup",
      `<script>\nconst $emit = () => {}\n</script>\n<script setup>\nconst a = 1\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
    ],
    [
      "a v-for alias",
      `<template>\n  <div>\n    <button v-for="$emit in callbacks" @click="$emit('click', 1)">x</button>\n  </div>\n</template>`,
    ],
    [
      "a destructured v-for alias on a wrapper",
      `<template>\n  <div>\n    <template v-for="{ $emit } in items">\n      <button @click="$emit('click', 1)">x</button>\n    </template>\n  </div>\n</template>`,
    ],
    [
      "an inline function parameter",
      `<template>\n  <button @click="(($emit) => $emit('click', 1))(notify)">x</button>\n</template>`,
    ],
  ])("stays silent on %s", async (_, source) => {
    expect(await reported(source)).toHaveLength(0);
  });

  test("still reports an Options API setup() that returns $emit, which the template proxy ignores", async () => {
    expect(
      await reported(
        `<script>\nexport default { setup() { return { $emit: () => {} } } }\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
      ),
    ).toHaveLength(1);
  });
});

describe("declaration guidance compiles", () => {
  test("adds a call signature to a call-signature type literal", async () => {
    const source = `<script setup lang="ts">\ndefineEmits<{ (e: 'close'): void }>()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`;
    const [diagnostic] = await reported(source);
    const signature = "(e: 'click', ...args: any[]): void";
    expect(diagnostic!.suggestion).toContain(
      `Add the call signature \`${signature}\` to the defineEmits type literal`,
    );
    expect(diagnostic!.suggestion).not.toContain("click: [");
    expect(compiledEmits(source.replace("void }", `void; ${signature} }`))).toEqual([
      "close",
      "click",
    ]);
    expect(() => compiledEmits(source.replace("void }", "void; click: [] }"))).toThrow(
      /mixed call signature and property syntax/,
    );
  });

  test("keeps the parameter name and names the interface", async () => {
    const source = `<script setup lang="ts">\ninterface Emits {\n  (event: 'close'): void\n}\ndefineEmits<Emits>()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`;
    const [diagnostic] = await reported(source);
    const signature = "(event: 'click', ...args: any[]): void";
    expect(diagnostic!.suggestion).toContain(
      `Add the call signature \`${signature}\` to \`interface Emits\``,
    );
    expect(compiledEmits(source.replace("void\n}", `void\n  ${signature}\n}`))).toEqual([
      "close",
      "click",
    ]);
  });

  test("adds a tuple property to a property-syntax type", async () => {
    const source = `<script setup lang="ts">\ndefineEmits<{ close: [] }>()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`;
    const [diagnostic] = await reported(source);
    const property = "click: [...args: any[]]";
    expect(diagnostic!.suggestion).toContain(
      `Add the property \`${property}\` to the defineEmits type literal`,
    );
    expect(diagnostic!.fix).toBeFalsy();
    expect(compiledEmits(source.replace("close: [] }", `close: []; ${property} }`))).toEqual([
      "close",
      "click",
    ]);
  });

  test("extends the event union of a function type", async () => {
    const source = `<script setup lang="ts">\ndefineEmits<(e: 'close', id: number) => void>()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`;
    const [diagnostic] = await reported(source);
    const rewritten = "(e: 'close' | 'click', id: number) => void";
    expect(diagnostic!.suggestion).toContain(`\`${rewritten}\``);
    expect(compiledEmits(source.replace("(e: 'close', id: number) => void", rewritten))).toEqual([
      "close",
      "click",
    ]);
  });

  test("replaces an argument-less defineEmits() instead of adding a second call", async () => {
    const source = `<script setup>\ndefineEmits()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`;
    const [diagnostic] = await reported(source);
    expect(diagnostic!.suggestion).toContain(
      "Replace `defineEmits()` with `defineEmits(['click'])`.",
    );
    expect(compiledEmits(source.replace("defineEmits()", "defineEmits(['click'])"))).toEqual([
      "click",
    ]);
  });
});

describe("merged interfaces", () => {
  test("reads members from every declaration of the interface", async () => {
    expect(
      await reported(
        `<script setup lang="ts">\ninterface E { (e: 'click'): void }\ninterface E { (e: 'close'): void }\ndefineEmits<E>()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
      ),
    ).toHaveLength(0);
  });

  test("still reports when no declaration has the event", async () => {
    expect(
      await reported(
        `<script setup lang="ts">\ninterface E { (e: 'open'): void }\ninterface E { (e: 'close'): void }\ndefineEmits<E>()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
      ),
    ).toHaveLength(1);
  });

  test("stays silent when an interface and a type alias share a name", async () => {
    expect(
      await reported(
        `<script setup lang="ts">\ninterface E { (e: 'open'): void }\ntype E = { (e: 'close'): void }\ndefineEmits<E>()\n</script>\n<template>\n  <button @click="$emit('click', 1)">x</button>\n</template>`,
      ),
    ).toHaveLength(0);
  });
});

describe("entity-encoded handlers", () => {
  test.each([
    [
      "&quot;",
      `<template>\n  <button @click="$emit(&quot;click&quot;, 1)">x</button>\n</template>`,
    ],
    [
      "&#39;",
      `<template>\n  <button @click="$emit(&#39;click&#39;, a &amp;&amp; b)">x</button>\n</template>`,
    ],
  ])("maps the event argument back to the raw %s text", async (entity, source) => {
    const [diagnostic] = await reported(source);
    const raw = source.slice(diagnostic!.range!.start, diagnostic!.range!.end);
    expect(raw).toBe(`${entity}click${entity}`);
  });

  test("stays silent when it cannot map an entity", async () => {
    expect(
      await reported(
        `<template>\n  <button @click="$emit(&quot;click&quot;, '&hellip;')">x</button>\n</template>`,
      ),
    ).toHaveLength(0);
  });
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
