import { expect, test } from "vite-plus/test";
import type { DoctorRule } from "../../../src/core/index.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import {
  noComputedSideEffects,
  noDuplicateAttrInheritance,
  noMutatingProps,
  noRequiredPropWithDefault,
  noVIfWithVFor,
} from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { runProjectFixture, runRuleFixture } from "../../../src/core/testkit.ts";

async function lines(rule: DoctorRule, source: string) {
  const result = await runRuleFixture({ rule, framework: "vue", files: { "app.vue": source } });
  for (const diagnostic of result.diagnostics) {
    expect(diagnostic.ruleId).toBe(rule.meta.id);
    expect(diagnostic.tags).toContain("eslint-plugin-vue");
  }
  return result.diagnostics.map((diagnostic) => diagnostic.range?.line);
}

async function codes(rule: DoctorRule, source: string) {
  const result = await runRuleFixture({ rule, framework: "vue", files: { "app.vue": source } });
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

test("the bridged defect rules are in the recommended preset", () => {
  const recommended = vueRulePack.presets?.recommended ?? [];
  for (const rule of [
    noMutatingProps,
    noComputedSideEffects,
    noVIfWithVFor,
    noDuplicateAttrInheritance,
    noRequiredPropWithDefault,
  ])
    expect(recommended).toContain(rule.meta.id);
});

test("VUE0027 reports shallow and deep prop writes", async () => {
  const source = `<script setup lang="ts">
const props = defineProps<{ count: number; user: { name: string } }>()
function bump() {
  props.count++
}
function rename() {
  props.user.name = 'renamed'
}
</script>
<template>
  <input v-model="props.user.name">
  <button type="button" @click="bump(); rename()">{{ count }}</button>
</template>`;

  expect(await lines(noMutatingProps, source)).toEqual([4, 7, 11]);
  expect(await codes(noMutatingProps, source)).toContain("VUE0027");
});

test("VUE0027 stays silent for local copies, emits, and defineModel", async () => {
  expect(
    await lines(
      noMutatingProps,
      `<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ count: number; user: { name: string } }>()
const emit = defineEmits<{ 'update:count': [value: number] }>()
const model = defineModel<string>()
const draft = ref(props.count)
const user = ref({ ...props.user })
function bump() {
  draft.value++
  user.value.name = 'renamed'
  model.value = 'next'
  emit('update:count', props.count + 1)
}
</script>
<template><input v-model="model"><button type="button" @click="bump">{{ draft }}</button></template>`,
    ),
  ).toEqual([]);
});

test("VUE0028 reports in-place sorts, writes, and async getters in computed", async () => {
  const source = `<script setup lang="ts">
import { computed, ref } from 'vue'
const items = ref([3, 1, 2])
const total = ref(0)
const sorted = computed(() => items.value.sort())
const counted = computed(() => {
  total.value = items.value.length
  return items.value
})
const remote = computed(async () => {
  return await fetch('/api/items')
})
</script>`;

  expect(await lines(noComputedSideEffects, source)).toEqual([5, 7, 10]);
  expect(new Set(await codes(noComputedSideEffects, source))).toEqual(new Set(["VUE0028"]));
});

test("VUE0028 stays silent for pure getters and side effects outside computed", async () => {
  expect(
    await lines(
      noComputedSideEffects,
      `<script setup lang="ts">
import { computed, ref, watch } from 'vue'
const items = ref([3, 1, 2])
const total = ref(0)
const sorted = computed(() => [...items.value].sort())
const reversed = computed(() => items.value.toReversed())
const local = computed(() => {
  const out: number[] = []
  for (const item of items.value) out.push(item * 2)
  return out.sort()
})
const loaded = ref<Response | null>(null)
watch(items, async () => {
  total.value = items.value.length
  loaded.value = await fetch('/api/items')
})
</script>`,
    ),
  ).toEqual([]);
});

test("VUE0028 accepts ignoredObjectNames for non-Promise .catch() APIs", async () => {
  const source = `<script setup lang="ts">
import { computed } from 'vue'
import { z } from 'zod'
const schema = computed(() => z.string().catch('fallback'))
</script>`;

  expect(await lines(noComputedSideEffects, source)).toEqual([4]);
  const configured = await runProjectFixture({
    rules: [noComputedSideEffects],
    framework: "vue",
    files: { "app.vue": source },
    config: {
      rules: { [noComputedSideEffects.meta.id]: ["error", { ignoredObjectNames: ["z"] }] },
    },
  });
  expect(configured.diagnostics).toEqual([]);
});

test("VUE0029 reports v-if that reads the v-for variable on the same element", async () => {
  const source = `<script setup lang="ts">
defineProps<{ items: Array<{ id: string; active: boolean }> }>()
</script>
<template>
  <ul>
    <li v-for="item in items" :key="item.id" v-if="item.active">{{ item.id }}</li>
  </ul>
</template>`;

  expect(await lines(noVIfWithVFor, source)).toEqual([6]);
  expect(await codes(noVIfWithVFor, source)).toEqual(["VUE0029"]);
});

test("VUE0029 stays silent when v-if ignores the loop variable or sits on a wrapper", async () => {
  expect(
    await lines(
      noVIfWithVFor,
      `<script setup lang="ts">
defineProps<{ items: Array<{ id: string; active: boolean }>; show: boolean }>()
</script>
<template>
  <ul>
    <li v-for="item in items" :key="item.id" v-if="show">{{ item.id }}</li>
    <template v-for="item in items" :key="item.id">
      <li v-if="item.active">{{ item.id }}</li>
    </template>
  </ul>
</template>`,
    ),
  ).toEqual([]);
});

test("VUE0030 reports $attrs bound to an inner element while attrs still fall through", async () => {
  const source = `<script setup lang="ts">
defineProps<{ label: string }>()
</script>
<template>
  <label class="field">
    {{ label }}
    <input v-bind="$attrs">
  </label>
</template>`;

  expect(await lines(noDuplicateAttrInheritance, source)).toEqual([7]);
  expect(await codes(noDuplicateAttrInheritance, source)).toEqual(["VUE0030"]);
});

test("VUE0030 stays silent with inheritAttrs false, multiple roots, or $attrs on the root", async () => {
  for (const source of [
    `<script setup lang="ts">
defineOptions({ inheritAttrs: false })
</script>
<template>
  <label class="field"><input v-bind="$attrs"></label>
</template>`,
    `<script setup lang="ts">
defineProps<{ label: string }>()
</script>
<template>
  <label>{{ label }}</label>
  <input v-bind="$attrs">
</template>`,
    `<script setup lang="ts">
defineProps<{ label: string }>()
</script>
<template>
  <button type="button" v-bind="$attrs">{{ label }}</button>
</template>`,
  ])
    expect(await lines(noDuplicateAttrInheritance, source)).toEqual([]);
});

test("VUE0031 reports required props that also declare a default", async () => {
  expect(
    await lines(
      noRequiredPropWithDefault,
      `<script setup lang="ts">
const props = withDefaults(defineProps<{
  size: string
  tone?: string
}>(), {
  size: 'md',
  tone: 'neutral',
})
</script>`,
    ),
  ).toEqual([3]);
  expect(
    await codes(
      noRequiredPropWithDefault,
      `<script setup lang="ts">
defineProps({
  size: { type: String, required: true, default: 'md' },
})
</script>`,
    ),
  ).toEqual(["VUE0031"]);
});

test("VUE0031 stays silent for optional props with defaults and required props without one", async () => {
  expect(
    await lines(
      noRequiredPropWithDefault,
      `<script setup lang="ts">
const { size = 'md', label } = defineProps<{ size?: string; label: string }>()
</script>`,
    ),
  ).toEqual([]);
});
