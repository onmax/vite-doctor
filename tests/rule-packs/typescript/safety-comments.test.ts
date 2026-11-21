import { parseSync } from "oxc-parser";
import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.js";
import {
  noChainedTypeAssertions,
  requireSafetyCommentForTypeAssertion,
} from "../../../src/rule-packs/typescript/index.js";
import { attachmentRegressions, cases } from "./safety-comment-cases.js";

test.each(cases)("checks %s", async (_name, source, expected) => {
  expect(parseSync("index.ts", source).errors).toEqual([]);
  const result = await runProjectFixture({
    framework: "vite",
    rules: [requireSafetyCommentForTypeAssertion],
    files: { "index.ts": source },
  });
  expect(result.diagnostics).toHaveLength(expected);
});

const propTypeCases: [string, string, number][] = [
  [
    "PropType from vue",
    'import { type PropType } from "vue"\nexport const props = { variant: { type: String as PropType<Variant> } }',
    0,
  ],
  [
    "aliased PropType from @vue/runtime-core",
    'import type { PropType as Prop } from "@vue/runtime-core"\nexport const props = { variant: { type: String as Prop<Variant> } }',
    0,
  ],
  [
    "PropType through a vue namespace",
    'import type * as Vue from "vue"\nexport const props = { variant: { type: String as Vue.PropType<Variant> } }',
    0,
  ],
  [
    "local type named PropType",
    "type PropType<T> = T\nexport const props = { variant: { type: String as PropType<Variant> } }",
    1,
  ],
  [
    "PropType from another module",
    'import type { PropType } from "./types"\nexport const props = { variant: { type: String as PropType<Variant> } }',
    1,
  ],
  [
    "other vue type",
    'import type { Ref } from "vue"\nexport const value = input as Ref<string>',
    1,
  ],
];

propTypeCases.push(
  [
    "shadowed alias",
    'import type { PropType } from "vue"; function read(input: unknown) { type PropType<T> = T; return input as PropType<string>; }',
    1,
  ],
  [
    "shadowed generic",
    'import type { PropType as Prop } from "vue"; function read<Prop>(input: unknown) { return input as Prop; }',
    1,
  ],
  [
    "shadowed namespace",
    'import type * as Vue from "vue"; namespace Local { namespace Vue { export type PropType<T> = T; } const read = input as Vue.PropType<string>; }',
    1,
  ],
  [
    "unrelated scope",
    'import type { PropType } from "vue"; function other() { type PropType<T> = T; } const read = input as PropType<string>;',
    0,
  ],
);

test.each(propTypeCases)("exempts Vue runtime prop types: %s", async (_name, source, expected) => {
  expect(parseSync("index.ts", source).errors).toEqual([]);
  const result = await runProjectFixture({
    framework: "vite",
    rules: [requireSafetyCommentForTypeAssertion],
    files: { "index.ts": source },
  });
  expect(result.diagnostics).toHaveLength(expected);
});

test("exempts PropType imported in a Vue SFC", async () => {
  const result = await runProjectFixture({
    rules: [requireSafetyCommentForTypeAssertion],
    files: {
      "App.vue":
        '<script setup lang="ts">\nimport type { PropType } from "vue"\ndefineProps({ variant: { type: String as PropType<Variant> } })\n</script>',
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["named", 'import type { PropType } from "vue";', "PropType<string>"],
  ["namespace", 'import type * as Vue from "vue";', "Vue.PropType<string>"],
])("exempts equivalent %s imports across SFC script blocks", async (_name, imports, type) => {
  const result = await runProjectFixture({
    rules: [requireSafetyCommentForTypeAssertion],
    files: {
      "App.vue": `<script lang="ts">
${imports}
export const textProp = String as ${type};
</script>
<script setup lang="ts">
${imports}
defineProps({ label: { type: String as ${type} } });
</script>`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

const chainCases: [string, string, number][] = [
  ["undocumented chain", "const value = input as unknown as User", 1],
  [
    "documented chain",
    "// SAFETY: schema validated this input.\nconst value = input as unknown as User",
    0,
  ],
  [
    "documented chain in a ternary branch",
    "const value = ready\n  // SAFETY: schema validated this input.\n  ? input as unknown as User\n  : undefined",
    0,
  ],
  [
    "documented chain in an if body",
    "function get() {\n// SAFETY: schema validated this input.\nif (ready) return input as unknown as User\n}",
    0,
  ],
  ["empty marker on a chain", "// SAFETY:\nconst value = input as unknown as User", 1],
  [
    "comment on an unrelated statement",
    "// SAFETY: validated\nconst other = 1; const value = input as unknown as User",
    1,
  ],
];

chainCases.push(
  ...attachmentRegressions.map(([name, source, expected]): [string, string, number] => [
    name,
    source.replace("input as User", "input as unknown as User"),
    expected,
  ]),
);

test.each(chainCases)("TS0001 checks %s", async (_name, source, expected) => {
  expect(parseSync("index.ts", source).errors).toEqual([]);
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noChainedTypeAssertions],
    files: { "index.ts": source },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(Array(expected).fill("TS0001"));
});

test("uses script comments at original Vue file offsets", async () => {
  const result = await runProjectFixture({
    rules: [requireSafetyCommentForTypeAssertion],
    files: {
      "App.vue":
        '<template><p>SAFETY: validated</p></template><script setup lang="ts">\nconst bad = input as User\n// SAFETY: schema validated this input.\nconst good = input as User\n</script>',
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(["TS0008"]);
});

test.each([false, true])("isolates safety comments with setup first: %s", async (setupFirst) => {
  const first = setupFirst ? 'script setup lang="ts"' : 'script lang="ts"';
  const second = setupFirst ? 'script lang="ts"' : 'script setup lang="ts"';
  const result = await runProjectFixture({
    rules: [requireSafetyCommentForTypeAssertion],
    files: {
      "App.vue": `<${first}>const first = 1 // SAFETY: validated</script><${second}>/* unrelated */ const bad = input as User; /* SAFETY: validated */ const good = input as User</script>`,
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(["TS0008"]);
});
