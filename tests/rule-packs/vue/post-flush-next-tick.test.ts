import { expect, test } from "vite-plus/test";
import { runVueSfcRuleFixture } from "../../rule-fixtures.ts";
import { requirePostFlushForDomWatch } from "../../../src/rule-packs/vue/rules/vue/require-post-flush-for-dom-watch.ts";

test.each([
  "watch(count, async () => { for (let i=0;i<1;i++) { await nextTick(); console.log(el.value.offsetWidth) } })",
  "watch(count, async () => { for (let i=0;await nextTick(),i<1;i++) { console.log(el.value.offsetWidth) } })",
  "watch(count, async () => { await nextTick(); const width = el.value.offsetWidth })",
  "watch(count, async () => { do { await nextTick() } while (false); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { do { if (enabled) return; await nextTick() } while (false); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { do { await nextTick(); if (enabled) break } while (enabled); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { do { await nextTick(); continue } while (false); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { switch (mode) { case 'measure': case 'resize': await nextTick(); break; default: return } console.log(el.value.offsetWidth) })",
  "watch(count, async () => { try { if (enabled) return; await nextTick() } finally { console.log(count) } console.log(el.value.offsetWidth) })",
  "watch(count, async () => { try { await nextTick(); return } finally { console.log(el.value.offsetWidth) } })",
  "watch(count, async () => { try { if (enabled) return } finally { await nextTick(); console.log(el.value.offsetWidth) } })",
  "watch(count, async () => { switch (mode) { case 'measure': await nextTick(); break; default: return } console.log(el.value.offsetWidth) })",
  "watch(count, async () => { if (enabled) await nextTick(); else await nextTick(); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { if (enabled) return; await nextTick(); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { if (enabled) await nextTick(); else return; console.log(el.value.offsetWidth) })",
  "watch(count, async () => { await nextTick(); console.log(el.value['offsetWidth']) })",
  "import { watch as observe, nextTick as flushed } from 'vue'; observe(count, async () => { await flushed(); console.log(el.value.offsetWidth) })",
  "import * as Vue from 'vue'; Vue.watch(count, async () => { await Vue.nextTick(); console.log(el.value.offsetWidth) })",
  "watch(count, () => { console.log('offsetWidth') })",
  "watch(count, () => { /* el.value.offsetWidth */ console.log(count) })",
  "watch(() => el.value.offsetWidth, value => console.log(value))",
  "watch(count, () => { const later = () => el.value.offsetWidth })",
  "watch(count, () => { nextTick(() => console.log(el.value.offsetWidth)) })",
  "watch(count, () => console.log(el.value.offsetWidth), { flush: 'post' })",
  "watch(count, () => console.log(el.value.offsetWidth), { ...options, flush: 'post' })",
  "import { watch } from 'other'; watch(count, () => el.value.offsetWidth)",
  "function outer(watch) { watch(count, () => el.value.offsetWidth) }",
])("accepts DOM reads after guaranteed flush or outside Vue callbacks: %s", async (script) => {
  const result = await runVueSfcRuleFixture(
    requirePostFlushForDomWatch,
    `<script setup>${script}</script>`,
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "watch(count, async () => { for (let i=0;i<1;await nextTick(),i++) { console.log(el.value.offsetWidth) } })",
  "watch(count, async () => { do { console.log(el.value.offsetWidth) } while (await nextTick(), enabled) })",
  "watch(count, async () => { while (enabled) { await nextTick() }; console.log(el.value.offsetWidth) })",
  "watch(count, () => console.log(el.value.offsetWidth))",
  "watch(count, async () => { console.log(el.value.offsetWidth); await nextTick() })",
  "watch(count, async () => { nextTick(); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { if (enabled) await nextTick(); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { enabled && await nextTick(); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { await nextTick(el.value.offsetWidth); })",
  "watch(count, async () => { const later = async () => { await nextTick() }; console.log(el.value.offsetWidth) })",
  "watch(count, async () => { const nextTick = async () => {}; await nextTick(); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { try { if (enabled) return; await nextTick() } finally { console.log(el.value.offsetWidth) } })",
  "watch(count, async () => { try { if (enabled) throw Error(); await nextTick() } finally { console.log(el.value.offsetWidth) } })",
  "watch(count, async () => { do { if (enabled) break; await nextTick() } while (false); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { do { if (enabled) continue; await nextTick() } while (false); console.log(el.value.offsetWidth) })",
  "watch(count, async () => { switch (mode) { case 'measure': await nextTick(); break } console.log(el.value.offsetWidth) })",
  "watch(count, async () => { switch (mode) { case 'measure': await nextTick(); default: break } console.log(el.value.offsetWidth) })",
  "watch(count, async () => { switch (mode) { case 'measure': if (enabled) break; await nextTick(); break; default: return } console.log(el.value.offsetWidth) })",
  "watch(count, async () => { switch (mode) { case 'measure': console.log(el.value.offsetWidth); case 'resize': await nextTick(); break; default: return } })",
  "import { nextTick } from 'other'; watch(count, async () => { await nextTick(); console.log(el.value.offsetWidth) })",
  "watch(count, () => { const settings = { flush: 'post' }; console.log(el.value.offsetWidth) })",
  "watch(count, () => console.log(el.value.offsetWidth), { flush: 'post', ...options })",
  "import { watch as observe } from 'vue'; observe(count, () => console.log(el.value.offsetWidth))",
  "import * as Vue from 'vue'; Vue.watch(count, () => console.log(el.value.offsetWidth))",
])("reports DOM reads reachable before guaranteed flush: %s", async (script) => {
  const result = await runVueSfcRuleFixture(
    requirePostFlushForDomWatch,
    `<script setup>${script}</script>`,
  );
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    requirePostFlushForDomWatch.meta.id,
  ]);
});
