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
