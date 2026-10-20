import { afterEach, expect, test, vi } from "vite-plus/test";
import { noRefAsOperand } from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { createEslintVueRule } from "../../../src/rule-packs/vue/rules/vue/shared.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";

const tsParses = vi.hoisted(() => ({ count: 0 }));

vi.mock("@typescript-eslint/parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("@typescript-eslint/parser")>();
  const parseForESLint: typeof original.parseForESLint = (code, options) => {
    tsParses.count++;
    return original.parseForESLint(code, options);
  };
  return { ...original, parseForESLint, default: { ...original, parseForESLint } };
});

afterEach(() => {
  tsParses.count = 0;
});

// A test-only bridge that borrows VUE0007's Doctor id so it has a registered Diagnostic Code.
const propsRuleId = "vue/reactivity/no-setup-props-destructure";
const propsBridge = createEslintVueRule({
  doctorId: propsRuleId,
  eslintId: ["vue/no-setup-props-reactivity-loss", "vue/no-mutating-props"],
  eslintOptions: (options, eslintId) =>
    eslintId === "vue/no-mutating-props" ? options : undefined,
  meta: {
    id: propsRuleId,
    title: "Test bridge",
    category: "reactivity",
    severity: "error",
    requires: { script: true, vue: true },
  },
});

const source = `<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ item: { name: string } }>()
const { item } = props
props.item.name = 'renamed'
const count = ref(0)
const doubled = count + 1
</script>
<template><p>{{ item.name }} {{ doubled }}</p></template>`;

function located(result: Awaited<ReturnType<typeof runProjectFixture>>) {
  return result.diagnostics
    .map((diagnostic) => [diagnostic.ruleId, diagnostic.range?.line, diagnostic.severity])
    .sort((left, right) => Number(left[1]) - Number(right[1]));
}

test("bridged rules on one file share one eslint parse and each report their own messages", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    rules: [noRefAsOperand, propsBridge],
    files: { "app.vue": source },
  });

  expect(tsParses.count).toBe(1);
  expect(located(result)).toEqual([
    [propsRuleId, 4, "error"],
    [propsRuleId, 5, "error"],
    ["vue/reactivity/no-ref-as-operand", 7, "error"],
  ]);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
    "VUE0006",
    "VUE0007",
    "VUE0007",
  ]);
});

test("each bridged rule keeps its own options and severity inside a shared batch", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    rules: [noRefAsOperand, propsBridge],
    files: { "app.vue": source },
    config: { rules: { [propsRuleId]: ["warn", { shallowOnly: true }] } },
  });

  expect(tsParses.count).toBe(1);
  expect(located(result)).toEqual([
    [propsRuleId, 4, "warn"],
    ["vue/reactivity/no-ref-as-operand", 7, "error"],
  ]);
});

test("disabling or suppressing one bridged rule leaves the others reporting", async () => {
  const disabled = await runProjectFixture({
    framework: "vue",
    rules: [noRefAsOperand, propsBridge],
    files: { "app.vue": source },
    config: { rules: { [propsRuleId]: "off" } },
  });
  expect(located(disabled)).toEqual([["vue/reactivity/no-ref-as-operand", 7, "error"]]);

  const suppressed = await runProjectFixture({
    framework: "vue",
    rules: [noRefAsOperand, propsBridge],
    files: {
      "app.vue": source.replace(
        "const doubled",
        "// doctor-disable-next-line vue/reactivity/no-ref-as-operand -- fixture\nconst doubled",
      ),
    },
  });
  expect(located(suppressed)).toEqual([
    [propsRuleId, 4, "error"],
    [propsRuleId, 5, "error"],
  ]);
  expect(suppressed.suppressedDiagnostics?.map((diagnostic) => diagnostic.ruleId)).toEqual([
    "vue/reactivity/no-ref-as-operand",
  ]);
});
