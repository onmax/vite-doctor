import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { requireLifecycleCleanup } from "../../../src/rule-packs/vue/rules/vue/index.ts";

const require = createRequire(new URL("../../../docs/package.json", import.meta.url));
const { effectScope, onScopeDispose } = require("vue");

afterEach(() => vi.useRealTimers());

async function diagnose(source: string) {
  return runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "vue",
    files: { "src/Component.vue": `<script setup lang="ts">${source}</script>` },
  });
}

test.each([
  `const timer = setInterval(() => {}, 1000); dialog.close()`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => dialog.close())`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => clearInterval(other))`,
  `const timer = setInterval(() => {}, 1000); function cleanup() { clearInterval(timer) }`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => { function unused() { clearInterval(timer) } })`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => { const timer = 1; clearInterval(timer) })`,
  `const timer = setInterval(() => {}, 1000); const text = 'clearInterval(timer)'`,
  `const timer = setInterval(() => {}, 1000); function onUnmounted(callback) {}; onUnmounted(() => clearInterval(timer))`,
  `let timer = setInterval(() => {}, 1000); timer = 0; onUnmounted(() => clearInterval(timer))`,
  `const timer = setInterval(() => {}, 1000); let cleanup = () => clearInterval(timer); cleanup = () => {}; onUnmounted(cleanup)`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => { if (skip) return; clearInterval(timer) })`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => { if (false) clearInterval(timer) })`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => { return; clearInterval(timer) })`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => { try { doWork() } catch { clearInterval(timer) } })`,
  `let resources = {}; resources.timer = setInterval(() => {}, 1000); resources = {}; onUnmounted(() => clearInterval(resources.timer))`,
  `const observer = new ResizeObserver(() => {}); onUnmounted(() => other.disconnect())`,
  `const socket = new WebSocket('wss://example.test'); onScopeDispose(() => dialog.close())`,
  `window.addEventListener('resize', handle); onUnmounted(() => window.removeEventListener('scroll', handle))`,
  `window.addEventListener('resize', handle); onUnmounted(() => window.removeEventListener('resize', other))`,
  `window.addEventListener('resize', handle, true); onUnmounted(() => window.removeEventListener('resize', handle, false))`,
  `window.addEventListener('resize', handle, { capture: false, capture: true }); onUnmounted(() => window.removeEventListener('resize', handle, false))`,
  `window.addEventListener('resize', handle, { ['capture']: true }); onUnmounted(() => window.removeEventListener('resize', handle, false))`,
  `let handler = () => {}; window.addEventListener('resize', handler); handler = () => {}; onUnmounted(() => window.removeEventListener('resize', handler))`,
])("lifecycle cleanup must dispose the acquired resource: %s", async (source) => {
  const result = await diagnose(source);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("VUE0004");
});

test.each([
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => clearInterval(timer))`,
  `const timer = setInterval(() => {}, 1000); onBeforeUnmount(() => clearInterval(timer))`,
  `const timer = setInterval(() => {}, 1000); onScopeDispose(() => clearInterval(timer))`,
  `const timer = setInterval(() => {}, 1000); const cleanup = () => clearInterval(timer); onUnmounted(cleanup)`,
  `import { onUnmounted as dispose } from 'vue'; const timer = setInterval(() => {}, 1000); dispose(() => clearInterval(timer))`,
  `import * as Vue from 'vue'; const timer = setInterval(() => {}, 1000); Vue.onUnmounted(() => clearInterval(timer))`,
  `let timer; onMounted(() => { timer = setInterval(() => {}, 1000) }); onUnmounted(() => clearInterval(timer))`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => { if (!timer) return; clearInterval(timer) })`,
  `const timer = setInterval(() => {}, 1000); onUnmounted(() => { try { doWork() } finally { clearInterval(timer) } })`,
  `let timer = setInterval(() => {}, 1000); onUnmounted(() => { clearInterval(timer); timer = 0 })`,
  `const observer = new ResizeObserver(() => {}); onUnmounted(() => observer.disconnect())`,
  `const socket = new WebSocket('wss://example.test'); onScopeDispose(() => socket.close())`,
  `window.addEventListener('resize', handle); onUnmounted(() => window.removeEventListener('resize', handle))`,
  `window.addEventListener('resize', handle, { capture: true }); onUnmounted(() => window.removeEventListener('resize', handle, true))`,
])("lifecycle cleanup recognizes the matching resource: %s", async (source) => {
  const result = await diagnose(source);
  expect(result.diagnostics).toHaveLength(0);
});

test("one lifecycle cleanup does not hide a second resource leak", async () => {
  const result = await diagnose(`
const first = setInterval(() => {}, 1000)
const second = setInterval(() => {}, 1000)
onUnmounted(() => clearInterval(first))
`);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.range?.line).toBe(3);
});

test("Vue scope disposal leaves an interval alive when cleanup closes an unrelated object", () => {
  vi.useFakeTimers();
  const scope = effectScope();
  let timer: ReturnType<typeof setInterval>;
  const close = vi.fn();
  scope.run(() => {
    timer = setInterval(() => {}, 1000);
    onScopeDispose(() => close());
  });
  scope.stop();
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  clearInterval(timer!);
});

test("Vue scope disposal clears the interval passed to its registered cleanup", () => {
  vi.useFakeTimers();
  const scope = effectScope();
  scope.run(() => {
    const timer = setInterval(() => {}, 1000);
    onScopeDispose(() => clearInterval(timer));
  });
  scope.stop();
  expect(vi.getTimerCount()).toBe(0);
});
