import { compileScript, parse } from "@vue/compiler-sfc";
import { expect, test } from "vite-plus/test";
import { runVueSfcRuleFixture } from "../../../src/core/testkit.ts";
import { definePropsWatchGetter } from "../../../src/rule-packs/vue/rules/vue/define-props-watch-getter.ts";

const props = "const { count } = defineProps<{ count: number }>()";

test.each([
  `${props}; function inner(count) { watch(count, () => {}) }`,
  `${props}; function inner({ count }) { watch(count, () => {}) }`,
  `${props}; { const count = ref(0); watch(count, () => {}) }`,
  `${props}; function inner() { watch(count, () => {}); var count = ref(0) }`,
  `${props}; try {} catch (count) { watch(count, () => {}) }`,
  `${props}; for (const count of refs) { watch(count, () => {}) }`,
  `${props}; const inner = function count() { watch(count, () => {}) }`,
  `${props}; function inner(watch) { watch(count, () => {}) }`,
  `import { watch } from 'other'; ${props}; watch(count, () => {})`,
  `${props}; const custom = { watch() {} }; custom.watch(count, () => {})`,
  `const { count, ...rest } = defineProps<{ count: number; other: number }>(); watch(rest, () => {})`,
  `import { defineProps } from 'other'; ${props}; watch(count, () => {})`,
  `${props}; watch(() => count, () => {})`,
  `${props}; watch(other, () => {})`,
  `import { watch as observe } from 'vue'; ${props}; function inner(observe) { observe(count, () => {}) }`,
  `import type { watch } from 'vue'; ${props}; watch(count, () => {})`,
])("does not rewrite a different binding: %s", async (script) => {
  const result = await runVueSfcRuleFixture(
    definePropsWatchGetter,
    `<script setup lang="ts">${script}</script>`,
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  [props, "watch(count, () => {})", "count"],
  [`import { watch } from 'vue'; ${props}`, "watch(count, () => {})", "count"],
  [`import { watch as observe } from 'vue'; ${props}`, "observe(count, () => {})", "count"],
  [`import * as Vue from 'vue'; ${props}`, "Vue.watch(count, () => {})", "count"],
  [
    "const { count: value = 0 } = defineProps<{ count?: number }>()",
    "watch(value, () => {})",
    "value",
  ],
  [props, "function inner() { watch(count, () => {}) }", "count"],
])("rewrites only the actual destructured prop: %s; %s", async (declaration, call, name) => {
  const source = `<script setup lang="ts">${declaration}; ${call}</script>`;
  const result = await runVueSfcRuleFixture(definePropsWatchGetter, source);
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    definePropsWatchGetter.meta.id,
  ]);
  const edit = result.diagnostics[0]!.fix!.edits[0]!;
  expect(source.slice(edit.range.start, edit.range.end)).toBe(name);
  const fixed = source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end);
  expect(fixed).toContain(`(() => ${name},`);
  expect(() => compileScript(parse(fixed).descriptor, { id: "test" })).not.toThrow();
  const rerun = await runVueSfcRuleFixture(definePropsWatchGetter, fixed);
  expect(rerun.diagnostics).toEqual([]);
});

test("agrees with Vue's compiler about a shadowed prop and a real invalid watch", async () => {
  const safe = `<script setup lang="ts">import { watch } from 'vue'; ${props}; function inner(count) { watch(count, () => {}) }</script>`;
  const invalid = `<script setup lang="ts">import { watch } from 'vue'; ${props}; watch(count, () => {})</script>`;
  expect(() => compileScript(parse(safe).descriptor, { id: "test" })).not.toThrow();
  expect(() => compileScript(parse(invalid).descriptor, { id: "test" })).toThrow(
    '"count" is a destructured prop',
  );
  const result = await runVueSfcRuleFixture(definePropsWatchGetter, safe);
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["import { watch as observe } from 'vue'", "observe(count, () => {})", 1],
  ["import { watch } from 'other'", "watch(count, () => {})", 0],
  ["function watch() {}", "watch(count, () => {})", 0],
])("resolves a normal script binding used in setup: %s", async (script, call, count) => {
  const source = `<script lang="ts">${script};</script><script setup lang="ts">${props}; ${call}</script>`;
  const result = await runVueSfcRuleFixture(definePropsWatchGetter, source);
  expect(result.diagnostics).toHaveLength(count);
});

test("finds a captured prop when the callback precedes its declaration", async () => {
  const source = `<script setup lang="ts">import { watch } from 'vue'; function start() { watch(count, () => {}) }; ${props}; start()</script>`;
  const result = await runVueSfcRuleFixture(definePropsWatchGetter, source);
  expect(result.diagnostics).toHaveLength(1);
});
