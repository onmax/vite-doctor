import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import { noDupeVElseIf } from "../../../src/rule-packs/vue/rules/vue/no-dupe-v-else-if.ts";

const project = createProjectFixture({ framework: "vue" });
afterAll(() => project.dispose());

const stableBindings =
  "const a = 1, b = 2, c = false, d = true, e = 0, f = false, foo = false, bar = true, baz = true, n = 2, open = true, wide = true, value = 'x', id = '1-2', status = 'loading', isAdmin = true, isOwner = false, isOpen = false, isPinned = true;";

const refBindings =
  "import { ref } from 'vue'; const a = ref(1), b = ref(2), c = ref(false), d = ref(true), e = ref(0), f = ref(false), foo = ref(false), bar = ref(true), baz = ref(true), n = ref(2);";

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
const upstreamValid = [
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
];

test.each(upstreamValid)("stays silent for upstream valid case %#", async (template) => {
  expect(await reportedBranches(template)).toEqual([]);
});

test.each(upstreamValid)("stays silent for upstream valid case %# over refs", async (template) => {
  expect(await reportedBranches(template, refBindings)).toEqual([]);
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

const vue = "import { computed, customRef, ref, shallowRef } from 'vue';";

/** The confidence of each reported branch, in template order. */
async function reportedConfidence(template: string, setup?: string) {
  const result = await project.run({
    rule: noDupeVElseIf,
    files: { "app.vue": sfc(template, setup) },
  });
  return result.diagnostics.map((diagnostic) => diagnostic.confidence);
}

// Pullfrog's probes on #358. Vue 3.5 SSR renders the second branch in all three.
test.each(["ref", "shallowRef"])(
  "does not report %s wrapping a customRef, which returns the customRef itself",
  async (wrap) => {
    const setup = `${vue} let reads = 0; const ready = ${wrap}(customRef(() => ({ get: () => ++reads === 2, set: () => {} })));`;
    expect(await reportedBranches('<p v-if="ready" /><p v-else-if="ready" />', setup)).toEqual([]);
  },
);

test("reports a getter-only computed that writes another read only as heuristic-high", async () => {
  const setup = `${vue} const ready = ref(false); const advance = computed(() => { ready.value = true; return false; });`;
  expect(
    await reportedConfidence(
      '<p v-if="ready || advance" /><p v-else-if="ready || advance" />',
      setup,
    ),
  ).toEqual(["heuristic-high"]);
});

test.each([
  ["a ref", `${vue} const ready = ref(false);`, "ready"],
  ["a ref without a value", `${vue} const ready = ref<boolean>();`, "ready"],
  ["a ref holding an array", `${vue} const ready = ref([]);`, "ready"],
  ["a ref holding an object", `${vue} const ready = ref({ open: true });`, "ready"],
  ["a shallowRef", `${vue} const ready = shallowRef(false);`, "ready"],
  ["a renamed ref import", "import { ref as box } from 'vue'; const ready = box(false);", "ready"],
  ["a getter-only computed", `${vue} const ready = computed(() => false);`, "ready"],
  [
    "a computed with a function getter",
    `${vue} const ready = computed(function () { return false; });`,
    "ready",
  ],
  ["a model", "const ready = defineModel<boolean>();", "ready"],
  ["a named model", "const ready = defineModel<boolean>('ready', { required: true });", "ready"],
  ["a bare type-based prop", "defineProps<{ ready: boolean }>();", "ready"],
  ["a bare runtime prop", "defineProps({ ready: Boolean });", "ready"],
  ["a bare array prop", "defineProps(['ready']);", "ready"],
  ["a destructured prop", "const { ready } = defineProps<{ ready: boolean }>();", "ready"],
  [
    "a renamed destructured prop",
    "const { open: ready } = defineProps<{ open: boolean }>();",
    "ready",
  ],
  ["a props member", "const props = defineProps<{ ready: boolean }>();", "props.ready"],
  ["an optional props member", "const props = defineProps<{ ready: boolean }>();", "props?.ready"],
  [
    "a props member with defaults",
    "const props = withDefaults(defineProps<{ ready?: boolean }>(), { ready: true });",
    "props.ready",
  ],
])("reports %s as heuristic-high", async (_name, setup, condition) => {
  expect(
    await reportedConfidence(`<p v-if="${condition}" /><p v-else-if="${condition}" />`, setup),
  ).toEqual(["heuristic-high"]);
});

test("reports the common ref status bug as heuristic-high and says when it holds", async () => {
  const source = sfc(
    "  <p v-if=\"status === 'loading'\">Loading</p>\n  <p v-else-if=\"status === 'loading'\">Failed</p>",
    `${vue} const status = ref('idle');`,
  );
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.code).toBe("VUE0043");
  expect(diagnostic!.confidence).toBe("heuristic-high");
  expect(diagnostic!.why).toBe(
    '<p v-else-if="status === \'loading\'"> never renders as long as "status" returns the same value each time one render reads it, which holds for plain refs, computed values and props. It repeats the condition of the earlier v-if="status === \'loading\'" on line 4 in the same chain, so Vue only reaches this branch after that condition was falsy.',
  );
});

test("names every non-constant read and mixes primitive constants into heuristic-high", async () => {
  const source = sfc(
    '  <A v-if="open && props.ready" />\n  <B v-else-if="props.ready && open && limit > 1" />',
    `${vue} const open = ref(true); const limit = 2; const props = defineProps<{ ready: boolean }>();`,
  );
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  expect(result.diagnostics.map((diagnostic) => [diagnostic.confidence, diagnostic.why])).toEqual([
    [
      "heuristic-high",
      '<B v-else-if="props.ready && open && limit > 1"> never renders as long as "props.ready" and "open" return the same value each time one render reads them, which holds for plain refs, computed values and props. Whenever it is truthy, the earlier v-if="open && props.ready" on line 4 in the same chain is truthy too, so Vue renders that branch instead.',
    ],
  ]);
});

test("reports heuristic-high when a ref branch sits between the repeated ones, and proven otherwise", async () => {
  const source = sfc(
    '  <A v-if="limit > 1" />\n  <B v-else-if="open" />\n  <C v-else-if="limit > 1" />',
    `${vue} const limit = 2; const open = ref(false);`,
  );
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  expect(result.diagnostics.map((diagnostic) => [diagnostic.confidence, diagnostic.why])).toEqual([
    [
      "heuristic-high",
      '<C v-else-if="limit > 1"> never renders as long as "open" returns the same value each time one render reads it, which holds for plain refs, computed values and props. It repeats the condition of the earlier v-if="limit > 1" on line 4 in the same chain, so Vue only reaches this branch after that condition was falsy.',
    ],
  ]);
  expect(
    await reportedConfidence(
      '<p v-if="open" /><p v-else-if="limit > 1" /><p v-else-if="limit > 1" />',
      `${vue} const limit = 2; const open = ref(false);`,
    ),
  ).toEqual(["proven"]);
});

test.each([
  ["a customRef", `${vue} const ready = customRef(() => ({ get: () => true, set: () => {} }));`],
  ["a toRef", "import { toRef } from 'vue'; const ready = toRef(() => false);"],
  ["a ref of another ref", `${vue} const base = ref(false); const ready = ref(base);`],
  ["a ref of a call", `${vue} const ready = ref(load());`],
  ["a ref of an identifier", `${vue} const initial = false; const ready = ref(initial);`],
  ["a let ref", `${vue} let ready = ref(false);`],
  ["a ref not imported from vue", "import { ref } from './my-ref'; const ready = ref(false);"],
  ["an unimported ref", "const ready = ref(false);"],
  ["a writable computed", `${vue} const ready = computed({ get: () => false, set: () => {} });`],
  ["a computed with a setter argument", `${vue} const ready = computed(() => false, {});`],
  [
    "a computed of an identifier",
    `${vue} const getter = () => false; const ready = computed(getter);`,
  ],
  [
    "a model with a getter",
    "const ready = defineModel<boolean>({ get: (value) => value, set: (value) => value });",
  ],
  ["a model with only a setter", "const ready = defineModel<boolean>({ set: (value) => value });"],
  ["a model with spread options", "const ready = defineModel<boolean>({ ...options });"],
  ["an imported binding", "import { ready } from './state';"],
  [
    "a reactive member",
    "import { reactive } from 'vue'; const state = reactive({ ready: false });",
    "state.ready",
  ],
  ["a $-prefixed ref", `${vue} const $ready = ref(false);`, "$ready"],
  ["an _-prefixed ref", `${vue} const _ready = ref(false);`, "_ready"],
  ["a $-prefixed constant", "const $ready = false;", "$ready"],
  ["an _-prefixed constant", "const _ready = false;", "_ready"],
])("does not compare %s", async (_name, setup, condition = "ready") => {
  expect(
    await reportedBranches(`<p v-if="${condition}" /><p v-else-if="${condition}" />`, setup),
  ).toEqual([]);
});

test.each([
  [
    "a deeper props chain",
    "const props = defineProps<{ user: { ready: boolean } }>();",
    "props.user.ready",
  ],
  ["a computed props key", "const props = defineProps<{ ready: boolean }>();", "props['ready']"],
  ["an undeclared props key", "const props = defineProps<{ ready: boolean }>();", "props.other"],
  ["a member of a ref", `${vue} const user = ref({ ready: true });`, "user.ready"],
  ["$props", "defineProps<{ ready: boolean }>();", "$props.ready"],
])("does not compare %s", async (_name, setup, condition) => {
  expect(
    await reportedBranches(`<p v-if="${condition}" /><p v-else-if="${condition}" />`, setup),
  ).toEqual([]);
});

test.each(["Math", "require"])(
  "does not assume a %s ref always resolves to setup",
  async (name) => {
    expect(
      await reportedBranches(
        `<p v-if="${name}" /><p v-else-if="(${name})" />`,
        `${vue} const ${name} = ref(false);`,
      ),
    ).toEqual([]);
  },
);

test("does not treat an options API prop as a script setup prop", async () => {
  const source = `<script lang="ts">export default { props: { ready: Boolean } };</script>${sfc('<p v-if="ready" /><p v-else-if="ready" />', "")}`;
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["a module ref import", "", ["heuristic-high"]],
  [
    "a shadowed module ref import",
    "function ref() { let reads = 0; return customRef(() => ({ get: () => ++reads === 2, set() {} })); }",
    [],
  ],
] as const)("resolves %s at the call site", async (_name, local, expected) => {
  const source = `<script lang="ts">import { ref, customRef } from 'vue';</script>${sfc(
    '<p v-if="ready" /><p v-else-if="ready" />',
    `${local} const ready = ref(false);`,
  )}`;
  const result = await project.run({ rule: noDupeVElseIf, files: { "app.vue": source } });
  expect(result.diagnostics.map(({ confidence }) => confidence)).toEqual(expected);
});

test.each(["reading >= 2", "reading == 2", "+reading >= 2", "`${reading}` === '2'"])(
  "does not assume %s can coerce the same object twice safely",
  async (condition) => {
    expect(
      await reportedBranches(
        `<p v-if="${condition}" /><p v-else-if="${condition}" />`,
        `${vue} let count = 0; const reading = shallowRef({ valueOf() { return ++count }, toString() { return String(++count) } });`,
      ),
    ).toEqual([]);
  },
);

test.each(["reading", "reading === 2", "reading != null", "(reading ? 2 : 1) >= 2"])(
  "still reports %s when evaluating it cannot coerce the read",
  async (condition) => {
    expect(
      await reportedConfidence(
        `<p v-if="${condition}" /><p v-else-if="${condition}" />`,
        `${vue} const reading = shallowRef({ valueOf() { return 2 } });`,
      ),
    ).toEqual(["heuristic-high"]);
  },
);

test.each([
  ["const props = defineProps<{ ready: boolean }>(); const ready = false;", "props.ready"],
  ["const props = defineProps({ ready: Boolean }); const ready = false;", "props.ready"],
  ["const props = defineProps(['ready']); const ready = false;", "props.ready"],
  [
    "const { open: ready } = withDefaults(defineProps<{ open?: boolean }>(), { open: false });",
    "ready",
  ],
])("traces a declared prop independently of bare binding metadata: %s", async (setup, read) => {
  expect(await reportedConfidence(`<p v-if="${read}" /><p v-else-if="${read}" />`, setup)).toEqual([
    "heuristic-high",
  ]);
});

test("observes changed prop type resolution config across runs", async () => {
  const source = sfc(
    '<p v-if="props.ready" /><p v-else-if="props.ready" />',
    "import type { Props } from '#props'; const props = defineProps<Props>();",
  );
  const run = (target: string) =>
    project.run({
      rule: noDupeVElseIf,
      run: { cache: false },
      files: {
        "app.vue": source,
        "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#props": [target] } } }),
        "ready.ts": "export interface Props { ready: boolean }",
        "other.ts": "export interface Props { other: boolean }",
      },
    });
  expect((await run("./ready.ts")).diagnostics.map(({ confidence }) => confidence)).toEqual([
    "heuristic-high",
  ]);
  expect((await run("./other.ts")).diagnostics).toEqual([]);
});

test("observes changed prop types after a failed compile", async () => {
  const source = sfc(
    '<p v-if="props.ready" /><p v-else-if="props.ready" />',
    "import type { Props } from './recover'; const props = defineProps<Props>();",
  );
  const run = (type: string) =>
    project.run({
      rule: noDupeVElseIf,
      run: { cache: false },
      files: { "app.vue": source, "recover.ts": type },
    });
  expect((await run("export interface Other { ready: boolean }")).diagnostics).toEqual([]);
  expect(
    (await run("export interface Props { ready: boolean }")).diagnostics.map(
      ({ confidence }) => confidence,
    ),
  ).toEqual(["heuristic-high"]);
  expect((await run("export interface Props { other: boolean }")).diagnostics).toEqual([]);
});

test("does not compare a ref shadowed by a v-for alias", async () => {
  expect(
    await reportedBranches(
      '<template v-for="ready in items"><p v-if="ready" /><p v-else-if="ready" /></template>',
      `${vue} const ready = ref(false); const items = [true];`,
    ),
  ).toEqual([]);
});

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
const upstreamInvalid: Array<[string, number[]]> = [
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
];

test.each(upstreamInvalid)("reports upstream invalid case %#", async (template, branches) => {
  expect(await reportedBranches(template)).toEqual(branches);
});

test.each(upstreamInvalid)(
  "checks upstream invalid case %# with ref bindings",
  async (template, branches) => {
    const expected = template.includes('v-if="1 < a"') ? [] : branches;
    const confidence = template.includes('v-if="true"') ? "proven" : "heuristic-high";
    expect(await reportedBranches(template, refBindings)).toEqual(expected);
    expect(await reportedConfidence(template, refBindings)).toEqual(expected.map(() => confidence));
  },
);

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
