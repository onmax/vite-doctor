import { afterEach, expect, test, vi } from "vite-plus/test";
import { runProjectFixture, runRuleFixture } from "../../../src/core/testkit.ts";
import {
  noAsyncWatchEffectAfterAwaitRead,
  noSetupPropsDestructure,
  requireLifecycleCleanup,
  requirePostFlushForDomWatch,
  requireUsePrefix,
  requireWatcherCleanup,
} from "../../../src/rule-packs/vue/rules/vue/index.ts";

const tsParses = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../../src/core/internal/lazy-parsers.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../src/core/internal/lazy-parsers.ts")>();
  const parseForESLint: typeof original.parseForESLint = (code, options) => {
    tsParses.count++;
    return original.parseForESLint(code, options);
  };
  return { ...original, parseForESLint };
});

afterEach(() => {
  tsParses.count = 0;
});

const scopeRules = [
  noSetupPropsDestructure,
  noAsyncWatchEffectAfterAwaitRead,
  requirePostFlushForDomWatch,
  requireUsePrefix,
  requireWatcherCleanup,
  requireLifecycleCleanup,
];

test("scope-analysis Rules share one TypeScript parse per file", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    rules: scopeRules,
    files: {
      "src/composables/feed.ts": `import { defineComponent, onMounted, watch, watchEffect } from 'vue'
export default defineComponent({
  setup(props) {
    const { title } = props
    return { title }
  },
})
export function startFeed(source) {
  onMounted(() => {})
  watch(source, () => {
    setInterval(() => {}, 1000)
  })
  watchEffect(async () => {
    await load()
    console.log(source.value)
  })
}`,
    },
  });

  expect(tsParses.count).toBe(1);
  expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.ruleId))).toEqual(
    new Set([
      "vue/reactivity/no-setup-props-destructure",
      "vue/watch/no-async-watcheffect-after-await-read",
      "vue/composables/require-use-prefix",
      "vue/watch/require-side-effect-cleanup",
      "vue/lifecycle/require-cleanup",
    ]),
  );
});

test("scope-analysis Rules skip files that cannot match without parsing them", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    rules: scopeRules,
    files: {
      "src/utils/format.ts": `// Formats labels; see the provide/inject docs.
export function formatLabel(value: string) {
  return value.trim()
}`,
      "src/utils/delay.ts": `export function later(tick: () => void) {
  return setTimeout(tick, 1000)
}`,
    },
  });

  expect(result.diagnostics).toEqual([]);
  expect(tsParses.count).toBe(1);
});

test("setup props Rule reads only script blocks when it decides to skip an SFC", () => {
  const ctx = {
    file: {
      text: `<script setup lang="ts">\nconst count = 1\n</script>`,
      sfc: { descriptor: { scriptSetup: { content: "\nconst count = 1\n" }, script: null } },
    },
  } as any;
  expect(noSetupPropsDestructure.create(ctx)).toBeUndefined();
  expect(noAsyncWatchEffectAfterAwaitRead.create(ctx)).toBeUndefined();
});

test("scope-analysis Rules still analyze names spelled with escapes", async () => {
  const setup = await runRuleFixture({
    rule: noSetupPropsDestructure,
    framework: "vue",
    files: {
      "src/widget.ts": String.raw`export default {
  setup(props) {
    const { title } = props
    return { title }
  },
}`,
    },
  });
  expect(setup.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    "vue/reactivity/no-setup-props-destructure",
  ]);

  const effect = await runRuleFixture({
    rule: noAsyncWatchEffectAfterAwaitRead,
    framework: "vue",
    files: {
      "src/effect.ts": String.raw`export function track(source) {
  watchEffect(async () => {
    await load()
    console.log(source.value)
  })
}`,
    },
  });
  expect(effect.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    "vue/watch/no-async-watcheffect-after-await-read",
  ]);
});

test.each([
  [
    "namespace member",
    `import * as Vue from 'vue'\nexport function start() { Vue.onMounted(() => {}) }`,
  ],
  [
    "computed namespace member",
    `import * as Vue from 'vue'\nexport function start() { Vue['onMounted'](() => {}) }`,
  ],
  [
    "aliased import",
    `import { inject as read } from 'vue'\nexport function theme() { return read(ThemeKey) }`,
  ],
  [
    "getCurrentInstance alias declared outside the function",
    `import { getCurrentInstance } from 'vue'\nconst current = () => getCurrentInstance()\nexport function emit() { const instance = getCurrentInstance(); return instance.emit }`,
  ],
])("use-prefix Rule keeps setup signals reached through a %s", async (_label, source) => {
  const result = await runRuleFixture({
    rule: requireUsePrefix,
    framework: "vue",
    files: { "src/composables/state.ts": source },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    "vue/composables/require-use-prefix",
  ]);
});
