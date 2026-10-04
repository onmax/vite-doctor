import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noUnsafeUseHeadScript } from "../../../src/rule-packs/nuxt/rules/nuxt/no-unsafe-use-head-script.ts";

test.each([
  '() => ({ script: [{ innerHTML: "window.ready = true" }] })',
  '() => { try { return { script: [{ innerHTML: "window.ready = true" }] } } finally {} }',
  '() => { try { throw new Error("failed") } catch { return { script: [{ innerHTML: "window.ready = true" }] } } }',
  '() => { try { return { title: "Ready" } } finally { return { script: [{ innerHTML: "window.ready = true" }] } } }',
  '() => ({ script: [{ src: "https://example.com/widget.js" }] })',
  'function () { return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { if (enabled) return { script: [{ innerHTML: "window.ready = true" }] }; return { title: "Ready" } }',
  '() => enabled ? { script: [{ innerHTML: "window.ready = true" }] } : { title: "Ready" }',
  '() => ({ script: [{ innerHTML: "window.ready = true" }] } as const)',
  '() => { if (enabled) { return { script: [{ innerHTML: "window.ready = true" }] } } }',
  '() => { if (enabled) return { title: "Ready" }; return { script: [{ innerHTML: "window.ready = true" }] } }',
])("reports executable script entries returned by reactive head getters: %s", async (getter) => {
  const result = await runRuleFixture({
    rule: noUnsafeUseHeadScript,
    framework: "nuxt",
    files: { "app/pages/head.vue": `<script setup lang="ts">useHead(${getter})</script>` },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([noUnsafeUseHeadScript.meta.id]);
});

test.each([
  '() => ({ title: "Ready" })',
  '() => { try { return { title: "Ready" } } finally {}; return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { try { return { script: [{ innerHTML: "window.ready = true" }] } } finally { return { title: "Ready" } } }',
  '() => { try { return { script: [{ innerHTML: "window.ready = true" }] } } finally { throw new Error("failed") } }',
  '() => { try { return { title: "Ready" } } catch { return { title: "Failed" } }; return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => ({ script: [{ type: "application/ld+json", innerHTML: "{}" }] })',
  '() => ({ script: [{ type: "application/json", innerHTML: "{}" }] })',
  '() => ({ script: [{ type: "importmap", innerHTML: "{}" }] })',
  '() => { const unused = () => ({ script: [{ innerHTML: "window.ready = true" }] }); return { title: "Ready" } }',
  '() => { function unused() { return { script: [{ innerHTML: "window.ready = true" }] } }; return { title: "Ready" } }',
  '() => false ? { script: [{ innerHTML: "window.ready = true" }] } : { title: "Ready" }',
  '() => { if (false) return { script: [{ innerHTML: "window.ready = true" }] }; return { title: "Ready" } }',
  '() => { return { title: "Ready" }; return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { throw new Error("stop"); return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { if (enabled) return { title: "Ready" }; else return { title: "Done" }; return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { if (true) return { title: "Ready" }; return { script: [{ innerHTML: "window.ready = true" }] } }',
])("preserves safe head getters and ignores unreturned nested values: %s", async (getter) => {
  const result = await runRuleFixture({
    rule: noUnsafeUseHeadScript,
    framework: "nuxt",
    files: { "app/pages/head.vue": `<script setup lang="ts">useHead(${getter})</script>` },
  });
  expect(result.diagnostics).toEqual([]);
});
