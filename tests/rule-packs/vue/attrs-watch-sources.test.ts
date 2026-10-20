import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { runVueSfcRuleFixture } from "../../rule-fixtures.ts";
import { noWatchUseAttrs } from "../../../src/rule-packs/vue/rules/vue/no-watch-use-attrs.ts";

const setup = (body: string, imports = "import { useAttrs, watch } from 'vue'") =>
  `<script setup lang="ts">\n${imports}\n${body}\n</script>`;

test.each([
  ["the attrs object", "const attrs = useAttrs()\nwatch(attrs, () => sync())", "attrs"],
  [
    "the attrs object with deep",
    "const attrs = useAttrs()\nwatch(attrs, () => sync(), { deep: true })",
    "attrs",
  ],
  [
    "a TypeScript-wrapped attrs object",
    "const attrs = useAttrs()\nwatch(attrs as any, sync)",
    "attrs as any",
  ],
  ["useAttrs() inline", "watch(useAttrs(), () => sync())", "useAttrs()"],
  [
    "attrs inside an array source",
    "const attrs = useAttrs()\nwatch([count, attrs], sync)",
    "attrs",
  ],
  [
    "a getter that returns attrs",
    "const attrs = useAttrs()\nwatch(() => attrs, sync)",
    "() => attrs",
  ],
])("reports watching %s", async (_, body, source) => {
  const result = await runVueSfcRuleFixture(noWatchUseAttrs, setup(body));
  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic).toMatchObject({ ruleId: noWatchUseAttrs.meta.id, code: "VUE0032" });
  const file = setup(body);
  expect(file.slice(diagnostic!.range!.start, diagnostic!.range!.end)).toBe(source);
});

test("reports auto-imported and namespace Vue APIs", async () => {
  const auto = await runVueSfcRuleFixture(
    noWatchUseAttrs,
    setup("const attrs = useAttrs()\nwatch(attrs, sync)", ""),
  );
  expect(auto.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noWatchUseAttrs.meta.id,
  ]);
  const namespace = await runVueSfcRuleFixture(
    noWatchUseAttrs,
    setup("const attrs = Vue.useAttrs()\nVue.watch(attrs, sync)", "import * as Vue from 'vue'"),
  );
  expect(namespace.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noWatchUseAttrs.meta.id,
  ]);
});

test.each([
  ["a getter reading one attribute", "const attrs = useAttrs()\nwatch(() => attrs.title, sync)"],
  [
    "a getter returning attrs with deep",
    "const attrs = useAttrs()\nwatch(() => attrs, sync, { deep: true })",
  ],
  ["an array source with deep", "const attrs = useAttrs()\nwatch([attrs], sync, { deep: true })"],
  ["options that may set deep", "const attrs = useAttrs()\nwatch(() => attrs, sync, options)"],
  ["watchEffect reading attrs", "const attrs = useAttrs()\nwatchEffect(() => sync(attrs.title))"],
  ["computed reading attrs", "const attrs = useAttrs()\nconst title = computed(() => attrs.title)"],
  ["a getter with a parameter", "const attrs = useAttrs()\nwatch((read) => attrs, sync)"],
  [
    "a shadowed attrs binding",
    "const attrs = useAttrs()\nfunction run(attrs) { watch(attrs, sync) }",
  ],
])("stays silent for %s", async (_, body) => {
  const result = await runVueSfcRuleFixture(
    noWatchUseAttrs,
    setup(body, "import { computed, useAttrs, watch, watchEffect } from 'vue'"),
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["useAttrs and watch from other libraries", "import { useAttrs, watch } from 'other'", ""],
  [
    "a local watch function",
    "import { useAttrs } from 'vue'",
    "const watch = (value, cb) => cb(value)",
  ],
])("stays silent for %s", async (_, imports, local) => {
  const result = await runVueSfcRuleFixture(
    noWatchUseAttrs,
    setup(`${local}\nconst attrs = useAttrs()\nwatch(attrs, sync)`, imports),
  );
  expect(result.diagnostics).toEqual([]);
});

test("reports components outside an SFC", async () => {
  const result = await runRuleFixture({
    rule: noWatchUseAttrs,
    framework: "vue",
    files: {
      "src/field.ts":
        "import { defineComponent, useAttrs, watch } from 'vue'\nexport default defineComponent({ setup() { const attrs = useAttrs(); watch(attrs, () => {}) } })",
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noWatchUseAttrs.meta.id,
  ]);
});
