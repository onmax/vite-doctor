import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { requireLifecycleCleanup } from "../../../src/rule-packs/vue/rules/vue/index.ts";

const require = createRequire(new URL("../../../docs/package.json", import.meta.url));
const { effectScope, onWatcherCleanup, watchEffect } = require("vue");

afterEach(() => vi.useRealTimers());

test.each([
  [
    `watchEffect((dispose) => { const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) })`,
    0,
  ],
  [
    `watchEffect(() => { const timer = setInterval(() => {}, 1000); onWatcherCleanup(() => clearInterval(timer)) })`,
    0,
  ],
  [`watchEffect(() => { const timer = setInterval(() => {}, 1000); return timer })`, 1],
  [`items.forEach(() => { const timer = setInterval(() => {}, 1000); return timer })`, 1],
  [
    `const effect = () => { const timer = setInterval(() => {}, 1000); return timer }; watchEffect(effect)`,
    1,
  ],
  [
    `function changed() { const timer = setInterval(() => {}, 1000); return timer }; watch(source, changed)`,
    1,
  ],
  [
    `function visit() { const timer = setInterval(() => {}, 1000); return timer }; items.forEach(visit)`,
    1,
  ],
  [
    `watchEffect(() => { const timer = setInterval(() => {}, 1000); onWatcherCleanup(() => clearInterval(other)) })`,
    1,
  ],
  [`const timer = setInterval(() => {}, 1000); onWatcherCleanup(() => clearInterval(timer))`, 1],
  [`const timer = setTimeout(() => {}, 1000)`, 0],
  [
    `watchEffect(async () => { const timer = setInterval(() => {}, 1000); await onWatcherCleanup(() => clearInterval(timer)) })`,
    0,
  ],
  [
    `watchEffect(async () => { const timer = setInterval(() => {}, 1000); if (false) await ready(); onWatcherCleanup(() => clearInterval(timer)) })`,
    0,
  ],
  [
    `watchEffect(async () => { const timer = setInterval(() => {}, 1000); await ready(); onWatcherCleanup(() => clearInterval(timer)) })`,
    1,
  ],
  [
    `watchEffect(async (dispose) => { const timer = setInterval(() => {}, 1000); await ready(); dispose(() => clearInterval(timer)) })`,
    0,
  ],
  [
    `watchEffect(() => { const timer = setInterval(() => {}, 1000); onMounted(() => onWatcherCleanup(() => clearInterval(timer))) })`,
    1,
  ],
  [
    `watchEffect((dispose) => { dispose = () => {}; const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) })`,
    1,
  ],
  [
    `watchEffect(() => { const timer = setInterval(() => {}, 1000); watchEffect(() => onWatcherCleanup(() => clearInterval(timer))) })`,
    1,
  ],
] as const)(
  "lifecycle cleanup shares valid watcher disposal evidence: %s",
  async (source, expected) => {
    const result = await runRuleFixture({
      rule: requireLifecycleCleanup,
      framework: "vue",
      files: { "src/Component.vue": `<script setup lang="ts">${source}</script>` },
    });

    expect(result.diagnostics).toHaveLength(expected);
  },
);

test("Vue stops watcher resources when their containing scope is disposed", () => {
  vi.useFakeTimers();
  const scope = effectScope();
  scope.run(() =>
    watchEffect(() => {
      const timer = setInterval(() => {}, 1000);
      onWatcherCleanup(() => clearInterval(timer));
    }),
  );
  expect(vi.getTimerCount()).toBe(1);
  scope.stop();
  expect(vi.getTimerCount()).toBe(0);
});
