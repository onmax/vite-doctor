import { expect, test } from "vite-plus/test";
import { runVueSfcRuleFixture } from "../../../src/core/testkit.ts";
import { noAsyncWatchEffectAfterAwaitRead } from "../../../src/rule-packs/vue/rules/vue/no-async-watch-effect-after-await-read.ts";

test.each([
  "const count = ref(0); watchEffect(async () => { for (let i=0;i<1;await load(),i++) { console.log(count.value) } })",
  "const count = ref(0); watchEffect(async () => { for (let i=0;i<1;console.log(count.value),i++) { await load(); break } })",
  "const count = ref(0); watchEffect(async () => { for (let i=0;i<1;console.log(count.value),i++) { await load(); return } })",
  "const count = ref(0); watchEffect(async () => { for (let i=0;i<1;console.log(count.value),i++) { await load(); throw new Error() } })",
  "const count = ref(0); watchEffect(async () => { do { console.log(count.value) } while (await load(), false) })",
  "const count = ref(0); watchEffect(async () => { switch (mode) { case 1: await load(); break; case 2: console.log(count.value) } })",
  "const count = ref(0); watchEffect(async () => { switch (mode) { case 1: if (enabled) { await load(); break }; case 2: console.log(count.value) } })",
  "const count = ref(0); watchEffect(async () => { false && await load(); console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { true || await load(); console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { if (false) await load(); console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { if (enabled) { await load(); return }; console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { if (enabled) await load(); else console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { enabled ? await load() : console.log(count.value) })",
  "let count = ref(0); count = { value: 1 }; watchEffect(async () => { await load(); console.log(count.value) })",
  "watchEffect(async () => { const value = state.value; await Promise.resolve(); console.log(value) })",
  "watchEffect(async () => { await load(); console.log('ready') })",
  "watchEffect(async () => { await load(); Math.max(1, 2) })",
  "const plain = { value: 1 }; watchEffect(async () => { await load(); console.log(plain.value) })",
  "const plain = { count: 1 }; watchEffect(async () => { await load(); console.log(plain.count) })",
  "const count = ref(0); watchEffect(async () => { await load(count.value) })",
  "const count = ref(0); watchEffect(async () => { const loadLater = async () => { await load() }; console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { await load(); const readLater = () => count.value })",
  "const count = ref(0); watchEffect(async () => { const message = 'await count.value'; console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { /* await load() */ console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { await load(); count.value = 2 })",
  "import { watchEffect } from 'other'; const count = ref(0); watchEffect(async () => { await load(); console.log(count.value) })",
  "const count = ref(0); function outer(watchEffect) { watchEffect(async () => { await load(); console.log(count.value) }) }",
  "const count = ref(0); watchEffect(async () => { await load(); { const count = { value: 1 }; console.log(count.value) } })",
])("ignores nonreactive reads and reads before suspension: %s", async (script) => {
  const result = await runVueSfcRuleFixture(
    noAsyncWatchEffectAfterAwaitRead,
    `<script setup lang="ts">${script}</script>`,
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "const count = ref(0); watchEffect(async () => { switch (mode) { case 1: await load(); case 2: console.log(count.value) } })",
  "const count = ref(0); watchEffect(async () => { switch (mode) { case 1: await load(); break }; console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { await load(); switch (mode) { case 1: console.log(count.value); break } })",
  "watchEffect(async () => { await load(); console.log(count.value) })",
  "import { count } from './state'; watchEffect(async () => { await load(); console.log(count.value) })",
  "import type { Ref } from 'vue'; function useCount(count: Ref<number>) { watchEffect(async () => { await load(); console.log(count.value) }) }",
  "const count = ref(0); watchEffect(async () => { await load(); console.log(count.value) })",
  "const count = shallowRef(0); watchEffect(async () => { await load(); console.log(count['value']) })",
  "const doubled = computed(() => 2); watchEffect(async () => { await load(); console.log(doubled.value) })",
  "const state = reactive({ count: 0 }); watchEffect(async () => { await load(); console.log(state.count) })",
  "const state = shallowReactive({ count: 0 }); watchEffect(async () => { await load(); console.log(state['count']) })",
  "const props = withDefaults(defineProps<{ count: number }>(), { count: 0 }); watchEffect(async () => { await load(); console.log(props.count) })",
  "const count = ref(0); watchEffect(async () => { if (enabled) await load(); console.log(count.value) })",
  "const count = ref(0); watchEffect(async () => { consume(await load(), count.value) })",
  "const count = ref(0); watchEffect(async () => { await load(); count.value++ })",
  "const count = ref(0); watchEffect(async () => { for (let i=0;i<1;await load(),console.log(count.value),i++) { continue } })",
  "const count = ref(0); watchEffect(async () => { for (let i=0;i<1;console.log(count.value),i++) { await load(); continue } })",
  "import { ref as reference, watchEffect as observe } from 'vue'; const count = reference(0); observe(async () => { await load(); console.log(count.value) })",
  "import * as Vue from 'vue'; const count = Vue.ref(0); Vue.watchEffect(async () => { await load(); console.log(count.value) })",
])("reports a reactive dependency read after suspension: %s", async (script) => {
  const result = await runVueSfcRuleFixture(
    noAsyncWatchEffectAfterAwaitRead,
    `<script setup lang="ts">${script}</script>`,
  );
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noAsyncWatchEffectAfterAwaitRead.meta.id,
  ]);
});
