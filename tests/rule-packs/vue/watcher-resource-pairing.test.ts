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

test.each([
  `let timer; function clearTimer() { if (!timer) return; clearTimeout(timer); timer = null }; watch(status, (value) => { clearTimer(); if (value) { timer = setTimeout(() => { timer = null }, 1500) } }, { immediate: true }); onBeforeUnmount(clearTimer)`,
  `let clock; watch(live, (isLive) => { if (clock) clearInterval(clock); clock = undefined; if (isLive) clock = setInterval(() => {}, 1000) }, { immediate: true }); onBeforeUnmount(() => { if (clock) clearInterval(clock) })`,
  `let stopped = false; let timer; function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined }; function schedule() { clearTimer(); if (stopped) return; timer = setTimeout(() => {}, 1000) }; watch(() => interval.value, schedule); function stop() { if (stopped) return; stopped = true; clearTimer() }; onScopeDispose(stop, true)`,
  `let timer; watch(status, (value) => { clearTimeout(timer); if (value) timer = setTimeout(() => {}, 1); else timer = setTimeout(() => {}, 2) }); onBeforeUnmount(() => clearTimeout(timer))`,
  `let stopped = false; let timer; watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onScopeDispose(() => { if (stopped) return; stopped = true; clearTimeout(timer) })`,
  `let timer; watch(status, (value) => { if (value) clearTimeout(timer); else return; timer = setTimeout(() => {}, 1500) }); onBeforeUnmount(() => clearTimeout(timer))`,
  `let timer; watch(status, () => { if (timer !== void 0) clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onBeforeUnmount(() => { if (timer !== void 0) clearTimeout(timer) })`,
])(
  "watcher accepts a reassigned outer handle cleared before reuse and on teardown: %s",
  async (source) => {
    const result = await diagnose(source);
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each([
  `let timer; watch(status, () => { timer = setTimeout(() => {}, 1500) })`,
  `let timer; watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1500) })`,
  `let timer; watch(status, () => { timer = setTimeout(() => {}, 1500) }); onBeforeUnmount(() => clearTimeout(timer))`,
  `let timer; let other; watch(status, () => { clearTimeout(other); timer = setTimeout(() => {}, 1500) }); onBeforeUnmount(() => clearTimeout(timer))`,
  `let timer; watch(status, (value) => { if (value) clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onBeforeUnmount(() => clearTimeout(timer))`,
  `let timer; watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onMounted(() => clearTimeout(timer))`,
  `let timer; watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1500); timer = undefined }); onBeforeUnmount(() => clearTimeout(timer))`,
  `let timer; watch(status, () => { clearInterval(timer); timer = setInterval(() => {}, 1000); onBeforeUnmount(() => clearInterval(timer)) })`,
  `let timer; watch(status, (clear) => { clearInterval(timer); timer = setInterval(() => {}, 1); if (clear) clearInterval(timer); timer = setInterval(() => {}, 2) }); onBeforeUnmount(() => clearInterval(timer))`,
  `let timer; function clearTimer() { timer = undefined; clearInterval(timer) }; watch(status, () => { clearTimer(); timer = setInterval(() => {}, 1000) }); onBeforeUnmount(() => clearInterval(timer))`,
  `let timer; function clearTimer() { if (skip) return; clearInterval(timer) }; watch(status, () => { clearTimer(); timer = setInterval(() => {}, 1000) }); onBeforeUnmount(() => clearInterval(timer))`,
  `let timer; watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); if (false) onBeforeUnmount(() => clearTimeout(timer))`,
  `let stopped = false; let timer; function stop() { if (stopped) return; stopped = true; clearTimeout(timer) }; stop(); watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onScopeDispose(stop)`,
  `let timer; function stop() { if (shouldCleanup) clearTimeout(timer) }; watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onBeforeUnmount(stop)`,
  `let timer; watch(status, (value) => { value && clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onBeforeUnmount(() => clearTimeout(timer))`,
  `let timer; watch(status, (values) => { for (const value of values) clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onBeforeUnmount(() => clearTimeout(timer))`,
  `let stopped = false; let timer; function stop() { if (stopped) return; stopped = true; clearTimeout(timer) }; function pause() { stopped = true }; watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1500) }); onScopeDispose(stop)`,
])(
  "watcher still reports a reassigned outer handle without reuse and teardown cleanup: %s",
  async (source) => {
    const result = await diagnose(source);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("VUE0021");
  },
);

test("Vue clears a reassigned watcher handle before reuse and on scope dispose", () => {
  vi.useFakeTimers();
  const scope = effectScope();
  const source = ref(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  scope.run(() => {
    watchEffect(
      () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {}, 1000 + source.value);
      },
      { flush: "sync" },
    );
    onScopeDispose(() => {
      if (timer) clearTimeout(timer);
    });
  });
  scope.run(() => {
    source.value++;
  });
  expect(vi.getTimerCount()).toBe(1);
  scope.stop();
  expect(vi.getTimerCount()).toBe(0);
});

test("watcher reports the acquisition that a later write in the same run overwrites", async () => {
  const source = `let timer; watch(status, () => { clearTimeout(timer); timer = setTimeout(() => {}, 1); timer = setTimeout(() => {}, 2) }); onBeforeUnmount(() => clearTimeout(timer))`;
  const result = await diagnose(source);
  expect(result.diagnostics).toHaveLength(1);
  const offset = '<script setup lang="ts">'.length + source.indexOf("setTimeout(() => {}, 1)");
  expect(result.diagnostics[0]?.range?.start).toBe(offset);
});
