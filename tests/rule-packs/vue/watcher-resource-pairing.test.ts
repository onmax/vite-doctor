import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { requireWatcherCleanup } from "../../../src/rule-packs/vue/rules/vue/index.ts";

const require = createRequire(new URL("../../../docs/package.json", import.meta.url));
const { effectScope, onScopeDispose, onWatcherCleanup, ref, watchEffect } = require("vue");

afterEach(() => vi.useRealTimers());

async function diagnose(source: string) {
  return runRuleFixture({
    rule: requireWatcherCleanup,
    framework: "vue",
    files: { "src/Component.vue": `<script setup lang="ts">${source}</script>` },
  });
}

test.each([
  `watchEffect(() => { const timer = setInterval(() => {}, 1000); dialog.close() })`,
  `watchEffect((onCleanup) => { const timer = setInterval(() => {}, 1000); onCleanup(() => clearInterval(other)) })`,
  `watchEffect(() => { const timer = setInterval(() => {}, 1000); onScopeDispose(() => clearInterval(timer)) })`,
  `watchEffect(() => { const timer = setInterval(() => {}, 1000); return () => clearInterval(timer) })`,
  `watchEffect(() => { const timer = setInterval(() => {}, 1000); function onCleanup(callback) {}; onCleanup(() => clearInterval(timer)) })`,
  `watchEffect((onCleanup) => { const timer = setInterval(() => {}, 1000); { const onCleanup = (fn) => {}; onCleanup(() => clearInterval(timer)) } })`,
  `watchEffect((onCleanup) => { const timer = setInterval(() => {}, 1000); onCleanup(() => { const timer = 0; clearInterval(timer) }) })`,
  `watchEffect(() => { const timer = setInterval(() => {}, 1000); watchEffect(() => onWatcherCleanup(() => clearInterval(timer))) })`,
  `watchEffect(() => { const observer = new ResizeObserver(() => {}); onWatcherCleanup(() => other.disconnect()) })`,
  `watchEffect(() => { const timer = setTimeout(() => {}, 1000); onWatcherCleanup(() => clearTimeout(other)) })`,
  `watchEffect(async () => { const timer = setInterval(() => {}, 1000); await ready(); onWatcherCleanup(() => clearInterval(timer)) })`,
  `watchEffect((dispose) => { dispose = () => {}; const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) })`,
  `watchEffect(() => { const timer = setInterval(() => {}, 1000); onMounted(() => onWatcherCleanup(() => clearInterval(timer))) })`,
  `watchEffect((dispose) => { const timer = setInterval(() => {}, 1000); onMounted(() => dispose(() => clearInterval(timer))) })`,
  `watchSyncEffect(() => { const timer = setInterval(() => {}, 1000) })`,
  `watchPostEffect(() => { const timer = setInterval(() => {}, 1000) })`,
  `watchEffect((dispose) => { window.addEventListener('resize', listener, true); dispose(() => window.removeEventListener('resize', listener, false)) })`,
  `import { onWatcherCleanup } from './not-vue'; watchEffect(() => { const timer = setInterval(() => {}, 1000); onWatcherCleanup(() => clearInterval(timer)) })`,
])("watcher cleanup must belong to the acquiring watcher and resource: %s", async (source) => {
  const result = await diagnose(source);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("VUE0021");
});

test.each([
  `watchEffect((dispose) => { const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) })`,
  `watch(source, (_value, _old, dispose) => { const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) })`,
  `watchEffect(() => { const timer = setInterval(() => {}, 1000); onWatcherCleanup(() => clearInterval(timer)) })`,
  `import { watchEffect as effect, onWatcherCleanup as dispose } from 'vue'; effect(() => { const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) })`,
  `import * as Vue from 'vue'; Vue.watchEffect(() => { const timer = setInterval(() => {}, 1000); Vue.onWatcherCleanup(() => clearInterval(timer)) })`,
  `watchEffect((dispose) => { const timer = setTimeout(() => {}, 1000); dispose(() => clearTimeout(timer)) })`,
  `watchEffect((dispose) => { const socket = new WebSocket('wss://example.test'); dispose(() => socket.close()) })`,
  `watchEffect((dispose) => { window.addEventListener('resize', listener); dispose(() => window.removeEventListener('resize', listener)) })`,
  `watchEffect((dispose) => { const timer = setInterval(() => {}, 1000); const cleanup = () => clearInterval(timer); dispose(cleanup) })`,
  `watchEffect(() => { const message = 'setInterval'; console.log(message) })`,
  `import { setInterval } from './scheduler'; watchEffect(() => setInterval(() => {}, 1000))`,
  `function watchEffect(callback) {}; watchEffect(() => setInterval(() => {}, 1000))`,
  `watchEffect(async (dispose) => { const timer = setInterval(() => {}, 1000); await ready(); dispose(() => clearInterval(timer)) })`,
  `watchEffect(async () => { const timer = setInterval(() => {}, 1000); onWatcherCleanup(() => clearInterval(timer)); await ready() })`,
  `watchEffect(async () => { const timer = setInterval(() => {}, 1000); await onWatcherCleanup(() => clearInterval(timer)) })`,
  `watchEffect(async () => { const timer = setInterval(() => {}, 1000); if (false) await ready(); onWatcherCleanup(() => clearInterval(timer)) })`,
  `watchEffect(() => { onMounted(() => { const timer = setInterval(() => {}, 1000) }) })`,
  `watchEffect(() => { const timer = setInterval(() => {}, 1000); clearInterval(timer) })`,
  `watchSyncEffect((dispose) => { const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) })`,
  `watchPostEffect((dispose) => { const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) })`,
  `function effect(dispose) { const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer)) }; watchEffect(effect)`,
])("watcher cleanup recognizes matching invalidation evidence: %s", async (source) => {
  const result = await diagnose(source);
  expect(result.diagnostics).toHaveLength(0);
});

test("watcher cleanup for one resource leaves the other acquisition reported", async () => {
  const result = await diagnose(`watchEffect((onCleanup) => {
  const first = setInterval(() => {}, 1000)
  const second = setInterval(() => {}, 1000)
  onCleanup(() => clearInterval(first))
})`);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.range?.line).toBe(3);
});

test("Vue scope cleanup does not cancel the previous watchEffect resource on invalidation", () => {
  vi.useFakeTimers();
  const scope = effectScope();
  const source = ref(0);
  scope.run(() =>
    watchEffect(
      () => {
        const timer = setInterval(() => {}, 1000 + source.value);
        onScopeDispose(() => clearInterval(timer));
      },
      { flush: "sync" },
    ),
  );
  scope.run(() => {
    source.value++;
  });
  expect(vi.getTimerCount()).toBe(2);
  scope.stop();
  expect(vi.getTimerCount()).toBe(0);
});

test("Vue watcher cleanup cancels the previous resource on invalidation and stop", () => {
  vi.useFakeTimers();
  const source = ref(0);
  const stop = watchEffect(
    () => {
      const timer = setInterval(() => {}, 1000 + source.value);
      onWatcherCleanup(() => clearInterval(timer));
    },
    { flush: "sync" },
  );
  source.value++;
  expect(vi.getTimerCount()).toBe(1);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

test("Vue bound watcher cleanup still registers after await", async () => {
  vi.useFakeTimers();
  const source = ref(0);
  const stop = watchEffect(
    async (dispose: (cleanup: () => void) => void) => {
      const timer = setInterval(() => {}, 1000 + source.value);
      await Promise.resolve();
      dispose(() => clearInterval(timer));
    },
    { flush: "sync" },
  );
  await Promise.resolve();
  source.value++;
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(1);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

test("Vue onWatcherCleanup cannot register after await", async () => {
  vi.useFakeTimers();
  const source = ref(0);
  const stop = watchEffect(
    async () => {
      const timer = setInterval(() => {}, 1000 + source.value);
      await Promise.resolve();
      onWatcherCleanup(() => clearInterval(timer), true);
    },
    { flush: "sync" },
  );
  await Promise.resolve();
  source.value++;
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(2);
  stop();
  expect(vi.getTimerCount()).toBe(2);
  vi.clearAllTimers();
});
