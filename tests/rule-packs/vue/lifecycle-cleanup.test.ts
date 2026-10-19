import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.js";
import { requireLifecycleCleanup } from "../../../src/rule-packs/vue/rules/vue/index.js";

test.each([
  `import { addEventListener } from './events'; export const directive = { created(el) { addEventListener(el, 'input', () => {}) } }`,
  `import { setInterval } from './scheduler'; setInterval(() => {}, 1000)`,
  `function addEventListener() {}; addEventListener('input', () => {})`,
  `function setup(setInterval) { setInterval(() => {}, 1000) }`,
  `function setup(window) { window.addEventListener('resize', () => {}) }`,
  `const window = { setInterval() {} }; window.setInterval(() => {}, 1000)`,
  `import { ResizeObserver } from './test-observer'; new ResizeObserver(() => {})`,
  `const setInterval = 'other'; window[setInterval](() => {}, 1000)`,
  `const directive = { created(el) { el.addEventListener('input', () => {}) } }`,
  `const message = "setInterval(() => {}, 1000)"`,
  `// addEventListener('input', () => {})`,
])("cleanup ignores browser API lookalikes: %s", async (source) => {
  const result = await runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "vue",
    files: { "src/useResource.ts": source },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  `setInterval(() => {}, 1000)`,
  `window.setInterval(() => {}, 1000)`,
  `window['setInterval'](() => {}, 1000)`,
  `globalThis.setInterval(() => {}, 1000)`,
  `addEventListener('input', () => {})`,
  `window.addEventListener('resize', () => {})`,
  `document.addEventListener('visibilitychange', () => {})`,
  `new ResizeObserver(() => {})`,
  `new window.ResizeObserver(() => {})`,
  `new IntersectionObserver(() => {})`,
  `new WebSocket('wss://example.test')`,
])("cleanup retains browser resource evidence: %s", async (source) => {
  const result = await runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "vue",
    files: { "src/useResource.ts": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("VUE0004");
});

test.each([
  `<script>window.addEventListener('resize', () => {})</script>\n<script setup>const window = {}</script>`,
  `<script>setInterval(() => {}, 1000)</script>\n<script setup>const setInterval = () => {}</script>`,
  `<script lang="ts">new ResizeObserver(() => {})</script>\n<script setup lang="ts">const ResizeObserver = class {}</script>`,
  `<script lang="ts">interface ResizeObserver { observe(): void }</script>\n<script setup lang="ts">new ResizeObserver(() => {})</script>`,
  `<template><div /></template><script setup lang="tsx">window.addEventListener('resize', () => <div />)</script>`,
])("cleanup preserves SFC browser resource scopes: %s", async (source) => {
  const result = await runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "vue",
    files: { "src/Component.vue": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("VUE0004");
});

test.each([
  `<script>import { setInterval } from './scheduler'</script>\n<script setup>setInterval(() => {}, 1000)</script>`,
  `<script>const window = { addEventListener() {} }</script>\n<script setup>window.addEventListener('resize', () => {})</script>`,
  `<script setup>const window = { addEventListener() {} }; window.addEventListener('resize', () => {})</script>`,
])("cleanup respects SFC local resource bindings: %s", async (source) => {
  const result = await runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "vue",
    files: { "src/Component.vue": source },
  });
  expect(result.diagnostics).toHaveLength(0);
});

const tabCapture = `export function useTabCapture() {
  let stream: MediaStream | null = null
  async function start() {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    const track = stream.getVideoTracks()[0]!
    track.addEventListener("ended", stop)
  }
  function stop() {
    stream?.getTracks().forEach(track => track.stop())
    stream = null
  }
  onScopeDispose(stop)
  return { start, stop }
}`;

test.each([
  ["a listener on a local object, stopped through onScopeDispose", tabCapture],
  [
    "a window listener removed by a named onScopeDispose callback",
    `export function useResize() {
  function onResize() {}
  window.addEventListener("resize", onResize)
  function stop() { window.removeEventListener("resize", onResize) }
  onScopeDispose(stop)
}`,
  ],
  [
    "a window listener removed by an auto-imported tryOnScopeDispose",
    `export function useResize() {
  function onResize() {}
  window.addEventListener("resize", onResize)
  tryOnScopeDispose(() => window.removeEventListener("resize", onResize))
}`,
  ],
  [
    "useEventListener, which removes its own listener",
    `export function useResize() { useEventListener(window, "resize", () => {}) }`,
  ],
])("cleanup accepts a Nuxt composable with %s", async (_, source) => {
  const result = await runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "nuxt",
    files: { "app/composables/useResource.ts": source },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  [
    "never removes its listener",
    `export function useResize() { window.addEventListener("resize", () => {}) }`,
  ],
  [
    "removes its listener from another composable's scope",
    `function onResize() {}
export function useResize() { window.addEventListener("resize", onResize) }
export function useOther() { onScopeDispose(() => window.removeEventListener("resize", onResize)) }`,
  ],
])("cleanup reports a Nuxt composable that %s", async (_, source) => {
  const result = await runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "nuxt",
    files: { "app/composables/useResource.ts": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("VUE0004");
});
