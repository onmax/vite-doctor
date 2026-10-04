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
  '() => enabled && { title: "Ready" } || { script: [{ innerHTML: "window.ready = true" }] }',
  '() => ({ script: [{ innerHTML: "window.ready = true" }] } as const)',
  '() => { if (enabled) { return { script: [{ innerHTML: "window.ready = true" }] } } }',
  '() => { if (enabled) return { title: "Ready" }; return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { for (const item of items) { return { script: [{ innerHTML: "code" }] } } return { title: "Ready" } }',
  '() => { while (enabled) { return { script: [{ innerHTML: "code" }] } } }',
  '() => { do { return { script: [{ innerHTML: "code" }] } } while (enabled) }',
  '() => { switch (mode) { case "ready": return { script: [{ innerHTML: "code" }] }; default: return { title: "Ready" } } }',
  '() => { label: { return { script: [{ innerHTML: "code" }] } } }',
  '() => { label: { break label } return { script: [{ innerHTML: "code" }] } }',
  '() => { try { work(); return { title: "Ready" } } catch { return { script: [{ innerHTML: "code" }] } } }',
  '() => enabled && { script: [{ innerHTML: "code" }] }',
  '() => { for (const item of items) { return { title: "Ready" } } return { script: [{ innerHTML: "code" }] } }',
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
  '() => 0 ? { script: [{ innerHTML: "window.ready = true" }] } : { title: "Ready" }',
  '() => "" ? { script: [{ innerHTML: "window.ready = true" }] } : { title: "Ready" }',
  '() => null ? { script: [{ innerHTML: "window.ready = true" }] } : { title: "Ready" }',
  '() => { if (false) return { script: [{ innerHTML: "window.ready = true" }] }; return { title: "Ready" } }',
  '() => { return { title: "Ready" }; return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { throw new Error("stop"); return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { if (enabled) return { title: "Ready" }; else return { title: "Done" }; return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { if (true) return { title: "Ready" }; return { script: [{ innerHTML: "window.ready = true" }] } }',
  '() => { try { return { title: "Ready" } } catch { return { script: [{ innerHTML: "window.ready = true" }] } } }',
  '() => { if (0) return { script: [{ innerHTML: "code" }] }; return { title: "Ready" } }',
  '() => false && { script: [{ innerHTML: "code" }] }',
  '() => ({ title: "Ready" }) || { script: [{ innerHTML: "code" }] }',
  '() => { while (false) { return { script: [{ innerHTML: "code" }] } } return { title: "Ready" } }',
  '() => { switch (mode) { case "ready": break; return { script: [{ innerHTML: "code" }] } } return { title: "Ready" } }',
])("preserves safe head getters and ignores unreturned nested values: %s", async (getter) => {
  const result = await runRuleFixture({
    rule: noUnsafeUseHeadScript,
    framework: "nuxt",
    files: { "app/pages/head.vue": `<script setup lang="ts">useHead(${getter})</script>` },
  });
  expect(result.diagnostics).toEqual([]);
});
