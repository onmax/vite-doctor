import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import { noDupeVElseIf } from "../../../src/rule-packs/vue/rules/vue/no-dupe-v-else-if.ts";

const project = createProjectFixture({ framework: "vue" });
afterAll(() => project.dispose());

const stableBindings =
  "const a = 1, b = 2, c = false, d = true, e = 0, f = false, foo = false, bar = true, baz = true, n = 2, open = true, wide = true, value = 'x', id = '1-2', status = 'loading', isAdmin = true, isOwner = false, isOpen = false, isPinned = true;";

function sfc(template: string, setup = stableBindings) {
  return `<script setup lang="ts">${setup}\n</script>\n<template>\n${template}\n</template>\n`;
}

/** The 1-based position, among the template's `v-else-if` attributes, of each reported branch. */
async function reportedBranches(template: string, setup?: string) {
  const source = sfc(template, setup);
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  return result.diagnostics.map((diagnostic) => {
    const before = source.slice(0, diagnostic.range!.start);
    return before.split("v-else-if").length - 1;
  });
}

// Valid cases from eslint-plugin-vue's no-dupe-v-else-if tests.
test.each([
  '<div v-if="foo" />\n<div v-else-if="bar" />\n<div v-else-if="baz" />',
  '<div v-if="foo">\n  <div v-else-if="foo" />\n</div>',
  '<div v-if="foo" />\n<div v-else-if="bar" />\n<div v-if="bar" />\n<div v-else-if="foo" />',
  '<div v-if="isSomething(x)" />\n<div v-else-if="isSomethingElse(x)" />\n<div v-if="a" />\n<div v-else-if="b" />\n<div v-else-if="c && d" />\n<div v-else-if="c && e" />\n<div v-if="n === 1" />\n<div v-else-if="n === 2" />\n<div v-else-if="n === 3" />\n<div v-else-if="n === 4" />\n<div v-else-if="n === 5" />',
  '<div v-if="foo" />\n<div />\n<div v-else-if="foo" />',
  "<div v-if />\n<div v-else-if />",
  '<div v-if="foo." />\n<div v-else-if="foo." />',
  '<div v-else-if="foo." />\n<div v-else-if="foo" />',
  '<div v-if="a" /><div v-else-if="b" />',
  '<div v-if="a" /><div v-else-if="b" /><div v-else-if="c" />',
  '<div v-if="true" /><div v-else-if="false" />',
  '<div v-if="1" /><div v-else-if="2" />',
  '<div v-if="f" /><div v-else-if="f()" />',
  '<div v-if="f(a)" /><div v-else-if="g(a)" />',
  '<div v-if="f(a)" /><div v-else-if="f(b)" />',
  '<div v-if="a === 1" /><div v-else-if="a === 2" />',
  '<div v-if="a === 1" /><div v-else-if="b === 1" />',
  '<div v-if="a" />',
  '<div v-if="a"><div v-if="a" /></div>',
  '<div v-if="a"><div v-if="b" /></div><div v-else-if="b" />',
  '<div v-if="a"><div v-if="b" /><div v-else-if="a" /></div>',
  '<div v-if="a" /><div v-else-if="!!a" />',
  '<div v-if="a || b" /><div v-else-if="c || d" />',
  '<div v-if="a || b" /><div v-else-if="a || c" />',
  '<div v-if="a" /><div v-else-if="a || b" />',
  '<div v-if="a" /><div v-else-if="b" /><div v-else-if="a || b || c" />',
  '<div v-if="a && b" /><div v-else-if="a" /><div v-else-if="b" />',
  '<div v-if="a && b" /><div v-else-if="b && c" /><div v-else-if="a && c" />',
  '<div v-if="a && b" /><div v-else-if="b || c" />',
  '<div v-if="a" /><div v-else-if="b && (a || c)" />',
  '<div v-if="a" /><div v-else-if="b && (c || d && a)" />',
  '<div v-if="a && b && c" /><div v-else-if="a && b && (c || d)" />',
])("stays silent for upstream valid case %#", async (template) => {
  expect(await reportedBranches(template)).toEqual([]);
});

// Upstream reports these. Doctor skips any condition with a call, which can return a different
// value on each evaluation.
test.each([
  '<div v-if="isSomething(x)" />\n<div v-else-if="isSomething(x)" />',
  '<div v-if="f(a)" /><div v-else-if="f(a)" />',
  '<div v-if="(a === b && fn(c)) || d" /><div v-else-if="fn(c) && a === b" />',
  '<div v-if="$slots.footer()" /><div v-else-if="$slots.footer()" />',
  '<div v-if="user.isAdmin()" /><div v-else-if="user.isAdmin()" />',
  '<div v-if="a" /><div v-else-if="a && next()" />',
  '<div v-if="a && next()" /><div v-else-if="a" />',
  '<div v-if="items[pick()]" /><div v-else-if="items[pick()]" />',
])("skips conditions with a call: %s", async (template) => {
  expect(await reportedBranches(template)).toEqual([]);
});

test.each([
  ["new", '<div v-if="new Set(ids).size" /><div v-else-if="new Set(ids).size" />'],
  ["an assignment", '<div v-if="(seen = a)" /><div v-else-if="(seen = a)" />'],
  ["an update", '<div v-if="count++" /><div v-else-if="count++" />'],
  ["a sequence", '<div v-if="(a, b)" /><div v-else-if="(a, b)" />'],
  ["a tagged template", '<div v-if="tag`a`" /><div v-else-if="tag`a`" />'],
  ["an arrow function", '<div v-if="() => a" /><div v-else-if="() => a" />'],
  ["an array literal", '<div v-if="[a]" /><div v-else-if="[a]" />'],
  [
    "a branch between them that writes state",
    '<div v-if="a" /><div v-else-if="(a = next)" /><div v-else-if="a" />',
  ],
  [
    "a branch between them that updates state",
    '<div v-if="a > 1" /><div v-else-if="a++ > 5" /><div v-else-if="a > 1" />',
  ],
  ["text between the branches", '<div v-if="a" /> text <div v-else-if="a" />'],
  ["a v-else between the branches", '<div v-if="a" /><div v-else /><div v-else-if="a" />'],
  ["optional and plain member reads", '<div v-if="a?.b" /><div v-else-if="a.b" />'],
  ["different literal keys", '<div v-if="items[0]" /><div v-else-if="items[1]" />'],
  ["different operators", '<div v-if="a < b" /><div v-else-if="a <= b" />'],
  ["swapped binary operands", '<div v-if="a === b" /><div v-else-if="b === a" />'],
  ["swapped ?? operands", '<div v-if="a ?? b" /><div v-else-if="b ?? a" />'],
])("stays silent for %s", async (_name, template) => {
  expect(await reportedBranches(template)).toEqual([]);
});

test.each(["Math", "require"])("does not assume %s always resolves to setup", async (name) => {
  expect(
    await reportedBranches(
      `<p v-if="${name}" /><p v-else-if="(${name})" />`,
      `const ${name} = false;`,
    ),
  ).toEqual([]);
});

test("recognizes a parenthesized primitive setup initializer", async () => {
  expect(
    await reportedBranches('<p v-if="ready" /><p v-else-if="ready" />', "const ready = ((true));"),
  ).toEqual([1]);
});

test.each([
  ["a swapped disjunction used as a value", "(left || right) === 2", "(right || left) === 2"],
  ["a swapped conjunction used as a value", "(left && right) === 1", "(right && left) === 1"],
])("does not match %s", async (_name, first, second) => {
  expect(
    await reportedBranches(
      `<p v-if="${first}" /><p v-else-if="${second}" />`,
      "const left = 1, right = 2;",
    ),
  ).toEqual([]);
});

test.each([
  [
    "a getter",
    "let reads = 0; const state = { get ready() { return ++reads === 2; } };",
    "state.ready",
  ],
  [
    "an auto-unwrapped customRef",
    "import { customRef } from 'vue'; let reads = 0; const ready = customRef(() => ({ get: () => ++reads === 2, set: () => {} }));",
    "ready",
  ],
  [
    "an effectful coercion",
    "let reads = 0; const value = { valueOf() { return ++reads; } };",
    "+value > 1",
  ],
  ["an unknown binding", "", "unknown"],
  ["a fresh regular expression", "", "/ready/"],
])("does not assume repeatability for %s", async (_name, setup, condition) => {
  expect(
    await reportedBranches(`<p v-if="${condition}" /><p v-else-if="${condition}" />`, setup),
  ).toEqual([]);
});

const vue = "import { computed, customRef, reactive, ref, shallowRef } from 'vue';";

test.each([
  ["a ref", `${vue} const status = ref('idle');`, "status === 'loading'"],
  ["a shallowRef", `${vue} const status = shallowRef('idle');`, "status === 'loading'"],
  ["a ref read for truthiness", `${vue} const user = ref(null);`, "!user"],
  ["a getter-only computed", `${vue} const ready = computed(() => Math.random() > 0.5);`, "ready"],
  ["a defineModel model", "const open = defineModel<boolean>('open');", "open"],
  ["a defineModel without a get option", "const open = defineModel({ default: false });", "open"],
  ["a bare type-declared prop", "defineProps<{ ready: boolean }>();", "ready"],
  ["a bare runtime-declared prop", "defineProps({ ready: Boolean });", "ready"],
  ["a bare array-declared prop", "defineProps(['ready']);", "ready"],
  ["a destructured prop", "const { ready = false } = defineProps<{ ready?: boolean }>();", "ready"],
  ["a props member", "const props = defineProps<Props>();", "props.ready"],
  ["a computed props member", "const props = defineProps<Props>();", "props['ready']"],
  [
    "a props member under withDefaults",
    "const props = withDefaults(defineProps<{ mode?: string }>(), { mode: 'a' });",
    "props.mode === 'a'",
  ],
  ["a parenthesized primitive constant", "const ready = (true);", "ready"],
  [
    "a ref with a TypeScript assertion",
    `${vue} const ready = ref(false) as Ref<boolean>;`,
    "ready",
  ],
  ["an auto-imported ref", "const status = ref('idle');", "status === 'loading'"],
])("reports a repeated read of %s", async (_name, setup, condition) => {
  expect(
    await reportedBranches(`<p v-if="${condition}" /><p v-else-if="${condition}" />`, setup),
  ).toEqual([1]);
});

test("reports a v-else-if that a ref condition already covers", async () => {
  expect(
    await reportedBranches(
      '<p v-if="isAdmin || isOwner" /><p v-else-if="isOwner" />',
      `${vue} const isAdmin = ref(false); const isOwner = computed(() => true);`,
    ),
  ).toEqual([1]);
});

test.each([
  [
    "a customRef",
    `${vue} let reads = 0; const ready = customRef(() => ({ get: () => ++reads === 2, set: () => {} }));`,
    "ready",
  ],
  ["a reactive() member", `${vue} const state = reactive({ ready: false });`, "state.ready"],
  ["a ref member", `${vue} const state = ref({ ready: false });`, "state.ready"],
  ["a deeper props member chain", "const props = defineProps<Props>();", "props.user.ready"],
  [
    "a computed props member with a dynamic key",
    "const props = defineProps<Props>();",
    "props[key]",
  ],
  [
    "a computed with a setter object",
    `${vue} const ready = computed({ get: () => false, set: () => {} });`,
    "ready",
  ],
  [
    "a defineModel with a get option",
    "let reads = 0; const open = defineModel({ get: () => ++reads === 2 });",
    "open",
  ],
  ["a defineModel destructured with modifiers", "const [open] = defineModel();", "open"],
  ["an imported binding", "import { ready } from './state';", "ready"],
  [
    "a ref from another library",
    "import { ref } from './fake'; const ready = ref(false);",
    "ready",
  ],
  ["a ref declared with let", `${vue} let ready = ref(false);`, "ready"],
  ["a ref under a coercing comparison", `${vue} const count = ref(0);`, "count > 1"],
  ["a ref under loose equality", `${vue} const count = ref(0);`, "count == 1"],
  ["a ref in a template literal", `${vue} const id = ref('a');`, "`${id}` === 'a'"],
  ["a bare prop declared by interface", "defineProps<Props>();", "ready"],
  [
    "a prop shadowed by a setup binding",
    "defineProps<{ ready: boolean }>(); const ready = Math.random() > 0.5;",
    "ready",
  ],
  ["a $-prefixed ref", `${vue} const $ready = ref(false);`, "$ready"],
])("does not compare %s", async (_name, setup, condition) => {
  expect(
    await reportedBranches(`<p v-if="${condition}" /><p v-else-if="${condition}" />`, setup),
  ).toEqual([]);
});

// Vue compiles a bare `Math` to the setup binding but `(Math)` to the global.
test.each([
  ["a primitive constant", "const Math = false;"],
  ["a ref", `${vue} const Math = ref(false);`],
  ["a prop", "defineProps<{ Math: boolean }>();"],
])(
  "does not treat a setup name that is also a Vue template global as one binding: %s",
  async (_name, setup) => {
    expect(await reportedBranches('<p v-if="Math" /><p v-else-if="(Math)" />', setup)).toEqual([]);
  },
);

test.each([
  [
    "a mutating function",
    "let ready = false; function advance() { ready = true; return false; }",
    "ready",
    "advance()",
  ],
  ["delete", "const state = { pending: true };", "!state.pending", "(delete state.pending, false)"],
  [
    "an unverified intervening call",
    "const ready = false; function advance() { return false; }",
    "ready",
    "advance()",
  ],
])("does not compare across %s", async (_name, setup, condition, intervening) => {
  expect(
    await reportedBranches(
      `<p v-if="${condition}" /><p v-else-if="${intervening}" /><p v-else-if="${condition}" />`,
      setup,
    ),
  ).toEqual([]);
});

test.each([
  '<template v-for="value in items"><p v-if="value" /><p v-else-if="value" /></template>',
  '<Widget v-slot="{ value }"><div><p v-if="value" /><p v-else-if="value" /></div></Widget>',
])("does not treat template aliases as setup constants: %s", async (template) => {
  expect(await reportedBranches(template)).toEqual([]);
});

test("does not treat a regular script constant as a template binding", async () => {
  const source = `<script lang="ts">const ready = false; export default { computed: { ready() { return Math.random() > 0.5; } } };</script>${sfc('<p v-if="ready" /><p v-else-if="ready" />', "")}`;
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  expect(result.diagnostics).toEqual([]);
});

// Invalid cases from eslint-plugin-vue's no-dupe-v-else-if tests, as the v-else-if branches reported.
test.each<[string, number[]]>([
  ['<div v-if="foo" />\n<div v-else-if="foo" />', [1]],
  [
    '<div v-if="a" />\n<div v-else-if="b" />\n<div v-else-if="c && d" />\n<div v-else-if="c && d" />',
    [3],
  ],
  [
    '<div v-if="n === 1" />\n<div v-else-if="n === 2" />\n<div v-else-if="n === 3" />\n<div v-else-if="n === 2" />\n<div v-else-if="n === 5" />',
    [3],
  ],
  ['<div v-if="a || b" />\n<div v-else-if="a" />', [1]],
  ['<div v-if="a" />\n<div v-else-if="b" />\n<div v-else-if="a || b" />', [2]],
  ['<div v-if="a" />\n<div v-else-if="a && b" />', [1]],
  ['<div v-if="a && b" />\n<div v-else-if="a && b && c" />', [1]],
  ['<div v-if="a || b" />\n<div v-else-if="b && c" />', [1]],
  [
    '<div v-if="a" />\n<div v-else-if="b && c" />\n<div v-else-if="d && (c && e && b || a)" />',
    [2],
  ],
  ['<div v-if="foo" />\n<div v-else-if="foo && bar" />\n<div v-else-if="baz && foo" />', [1, 2]],
  [
    '<div v-if="a && b" />\n<div v-else-if="a && b && c" />\n<div v-else-if="a && c && b" />',
    [1, 2],
  ],
  ['<div v-if="a || b" />\n<div v-else-if="a" />\n<div v-else-if="b" />', [1, 2]],
  [
    '<div v-if      ="((f && e) || d) && c || (b && a)" />\n<div v-else-if ="(a && b) || (c && (d || (e && f)))" />\n<div v-else-if ="(a && b) || (c && (d || (e && f)))" />',
    [1, 2],
  ],
  ['<div v-if="a" /><div v-else-if="a" />', [1]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="a" /><div v-else-if="c" />', [2]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="a" />', [2]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="c" /><div v-else-if="a" />', [3]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="b" />', [2]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="c" /><div v-else-if="b" />', [3]],
  [
    '<div v-if="a" /><div v-else-if="b" /><div v-else-if="c" /><div v-else-if="b" /><div v-else-if="d" />',
    [3],
  ],
  [
    '<div v-if="a" /><div v-else-if="b" /><div v-else-if="c" /><div v-else-if="d" /><div v-else-if="b" /><div v-else-if="e" />',
    [4],
  ],
  ['<div v-if="a" /><div v-else-if="a" /><div v-else-if="a" />', [1, 2]],
  [
    '<div v-if="a" /><div v-else-if="b" /><div v-else-if="a" /><div v-else-if="b" /><div v-else-if="a" />',
    [2, 3, 4],
  ],
  ['<div v-if="a"><div v-if="b" /></div><div v-else-if="a" />', [1]],
  ['<div v-if="a === 1" /><div v-else-if="a === 1" />', [1]],
  ['<div v-if="1 < a" /><div v-else-if="1 < a" />', [1]],
  ['<div v-if="true" /><div v-else-if="true" />', [1]],
  ['<div v-if="a && b" /><div v-else-if="a && b" />', [1]],
  ['<div v-if="a && b || c" /><div v-else-if="a && b || c" />', [1]],
  ['<div v-if="a === 1" /><div v-else-if="a===1" />', [1]],
  ['<div v-if="a === 1" /><div v-else-if="a === /* comment */ 1" />', [1]],
  ['<div v-if="a || b" /><div v-else-if="a" />', [1]],
  ['<div v-if="a || b" /><div v-else-if="a" /><div v-else-if="b" />', [1, 2]],
  ['<div v-if="a || b" /><div v-else-if="b || a" />', [1]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="a || b" />', [2]],
  ['<div v-if="a || b" /><div v-else-if="c || d" /><div v-else-if="a || d" />', [2]],
  ['<div v-if="a" /><div v-else-if="a && b" />', [1]],
  ['<div v-if="a && b" /><div v-else-if="a && b && c" />', [1]],
  ['<div v-if="a || c" /><div v-else-if="a && b || c" />', [1]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="c && a || b" />', [2]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="c && (a || b)" />', [2]],
  ['<div v-if="a" /><div v-else-if="b && c" /><div v-else-if="d && (a || e && c && b)" />', [2]],
  ['<div v-if="a || b && c" /><div v-else-if="b && c && d" />', [1]],
  ['<div v-if="a || b" /><div v-else-if="b && c" />', [1]],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="(a || b) && c" />', [2]],
  ['<div v-if="(a && (b || c)) || d" /><div v-else-if="(c || b) && e && a" />', [1]],
  ['<div v-if="a && b || b && c" /><div v-else-if="a && b && c" />', [1]],
  ['<div v-if="a" /><div v-else-if="b && c" /><div v-else-if="d && (c && e && b || a)" />', [2]],
  ['<div v-if="a || (b && (c || d))" /><div v-else-if="(d || c) && b" />', [1]],
  ['<div v-if="a || b" /><div v-else-if="(b || a) && c" />', [1]],
  [
    '<div v-if="a || b" /><div v-else-if="c" /><div v-else-if="d" /><div v-else-if="b && (a || c)" />',
    [3],
  ],
  ['<div v-if="a || b || c" /><div v-else-if="a || (b && d) || (c && e)" />', [1]],
  ['<div v-if="a || (b || c)" /><div v-else-if="a || (b && c)" />', [1]],
  [
    '<div v-if="a || b" /><div v-else-if="c" /><div v-else-if="d" /><div v-else-if="(a || c) && (b || d)" />',
    [3],
  ],
  ['<div v-if="a" /><div v-else-if="b" /><div v-else-if="c && (a || d && b)" />', [2]],
  ['<div v-if="a" /><div v-else-if="a || a" />', [1]],
  ['<div v-if="a || a" /><div v-else-if="a || a" />', [1]],
  ['<div v-if="a || a" /><div v-else-if="a" />', [1]],
  ['<div v-if="a" /><div v-else-if="a && a" />', [1]],
  ['<div v-if="a && a" /><div v-else-if="a && a" />', [1]],
  ['<div v-if="a && a" /><div v-else-if="a" />', [1]],
])("reports upstream invalid case %#", async (template, branches) => {
  expect(await reportedBranches(template)).toEqual(branches);
});

test.each([
  // Upstream compares tokens and keeps this valid; Doctor compares the parsed expression.
  ["extra parentheses", '<div v-if="a === 1" /><div v-else-if="a === (1)" />'],
  ["spacing and parentheses", '<div v-if="a===1" /><div v-else-if="( a  ===  1 )" />'],
  ["a comment between branches", '<div v-if="a" />\n<!-- fallback -->\n<div v-else-if="a" />'],
  [
    "<template> branches",
    '<template v-if="open"><p>A</p></template>\n<template v-else-if="open"><p>B</p></template>',
  ],
  [
    "typeof and unary operators",
    "<p v-if=\"typeof value === 'string'\" /><p v-else-if=\"typeof value === 'string'\" />",
  ],
  ["negation", '<p v-if="!(a || b)" /><p v-else-if="!(b || a)" />'],
  ["a conditional", '<p v-if="wide ? a : b" /><p v-else-if="wide ? a : b" />'],
  ["a template literal", '<p v-if="`${a}-${b}` === id" /><p v-else-if="`${a}-${b}` === id" />'],
  ["a TypeScript assertion", '<p v-if="(value as string)" /><p v-else-if="value!" />'],
])("reports a repeated condition with %s", async (_name, template) => {
  expect(await reportedBranches(template)).toEqual([1]);
});

test("names the earlier condition and its line in why, and offers no fix", async () => {
  const source = sfc(
    "  <p v-if=\"status === 'loading'\">Loading</p>\n  <p v-else-if=\"status === 'loading'\">Failed</p>",
  );
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  const [diagnostic] = result.diagnostics;
  expect(result.diagnostics).toHaveLength(1);
  expect(diagnostic!.code).toBe("VUE0043");
  expect(diagnostic!.severity).toBe("warn");
  expect(diagnostic!.confidence).toBe("proven");
  expect(diagnostic!.fix ?? null).toBeNull();
  expect(diagnostic!.range!.line).toBe(5);
  expect(source.slice(diagnostic!.range!.start, diagnostic!.range!.end)).toBe(
    "status === 'loading'",
  );
  expect(diagnostic!.why).toBe(
    "<p v-else-if=\"status === 'loading'\"> never renders. It repeats the condition of the earlier v-if=\"status === 'loading'\" on line 4 in the same chain, so Vue only reaches this branch after that condition was falsy.",
  );
  expect(diagnostic!.suggestion).toBe(
    "Change v-else-if=\"status === 'loading'\" to the condition this <p> was meant to test, or remove the branch if it is no longer needed.",
  );
});

test("names every earlier branch that covers the condition", async () => {
  const source = sfc(
    '  <A v-if="isAdmin" />\n  <B v-else-if="isOwner" />\n  <C v-else-if="isAdmin || isOwner" />',
  );
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  expect(result.diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
    '<C v-else-if="isAdmin || isOwner"> never renders. Whenever it is truthy, one of the earlier v-if="isAdmin" on line 4 or v-else-if="isOwner" on line 5 in the same chain is truthy too, so Vue renders that branch instead.',
  ]);
});

test("names the covered operand of an && condition", async () => {
  const source = sfc(
    '  <A v-if="isOpen || isPinned" />\n  <B v-else-if=" wide &amp;&amp; isPinned " />',
  );
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  expect(result.diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
    '<B v-else-if="wide && isPinned"> never renders. It requires "isPinned", which is only truthy when the earlier v-if="isOpen || isPinned" on line 4 in the same chain is truthy too, so Vue renders that branch instead.',
  ]);
});
