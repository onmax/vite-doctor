import { expect, test } from "vite-plus/test";
import {
  computedNoAsync,
  computedNoSideEffects,
  definePropsWatchGetter,
  noAfterAwait,
  noPropMutation,
  noRefAsOperand,
  noVIfWithVFor,
  noBrowserApiInSetup,
} from "../src/rules/vue.ts";
import { createRule } from "../src/index.ts";
import {
  runNuxtAppRuleFixture,
  runNuxtManifestRuleFixture,
  runRuleFixture,
  runVueSfcRuleFixture,
} from "../src/testkit.ts";

test("runs a Vue rule fixture", async () => {
  const result = await runVueSfcRuleFixture(
    definePropsWatchGetter,
    `<script setup lang="ts">
const { count } = defineProps<{ count: number }>()
watch(count, () => {})
</script>`,
  );

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.ruleId).toBe("vue/reactivity/defineprops-watch-getter");
});

test("runs a Nuxt rule fixture", async () => {
  const rule = createRule({
    meta: {
      id: "test/nuxt-rule",
      title: "Nuxt rule",
      category: "architecture",
      severity: "warn",
      requires: { script: true, nuxt: true },
    },
    create(ctx) {
      return {
        ScriptNode(node) {
          if (!ctx.helpers.isCall(node, "useFetch")) return;
          ctx.helpers.report(ctx, node, {
            ruleId: "test/nuxt-rule",
            severity: "warn",
            category: "architecture",
            message: "Nuxt app rule ran.",
          });
        },
      };
    },
  });
  const result = await runNuxtAppRuleFixture(
    rule,
    `<script setup lang="ts">
useFetch('/api/user')
</script>`,
    "app/pages/account.vue",
  );

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.ruleId).toBe("test/nuxt-rule");
});

test("runs a Nuxt manifest rule fixture", async () => {
  const rule = createRule({
    meta: {
      id: "test/nuxt-manifest",
      title: "Read Nuxt manifest",
      category: "architecture",
      severity: "warn",
      requires: { nuxt: true, crossFile: true },
    },
    create(ctx) {
      return {
        NuxtManifest(manifest) {
          if (!manifest.serverDirs.api.length) return;
          ctx.helpers.report(ctx, ctx.file.scriptAst, {
            ruleId: "test/nuxt-manifest",
            severity: "warn",
            category: "architecture",
            message: "Nuxt API handlers were detected.",
          });
        },
      };
    },
  });

  const result = await runNuxtManifestRuleFixture(rule, {
    "app.vue": "<template />",
    "server/api/user.ts": "export default defineEventHandler(() => ({}))",
  });

  expect(result.diagnostics[0]?.ruleId).toBe("test/nuxt-manifest");
});

test("rule helpers provide shared AST and template predicates", async () => {
  const rule = createRule({
    meta: {
      id: "test/shared-helpers",
      title: "Use shared helpers",
      category: "architecture",
      severity: "warn",
      requires: { script: true, template: true, vue: true },
    },
    create(ctx) {
      return {
        ScriptNode(node) {
          if (!ctx.helpers.isCall(node, "watch")) return;
          ctx.helpers.report(ctx, node, {
            ruleId: "test/shared-helpers",
            severity: "warn",
            category: "architecture",
            message: ctx.helpers.getCalleeName(node) ?? "unknown",
          });
        },
        TemplateNode(node) {
          if (!ctx.helpers.hasVueDirective(node, "for")) return;
          ctx.helpers.report(ctx, node, {
            ruleId: "test/shared-helpers",
            severity: "warn",
            category: "architecture",
            message: ctx.helpers.getStaticVueAttributeValue(node, "ref") ?? "missing-ref",
          });
        },
      };
    },
  });

  const result = await runVueSfcRuleFixture(
    rule,
    `<template><div v-for="item in items" ref="row">{{ item }}</div></template>
<script setup lang="ts">
watch(() => true, () => {})
</script>`,
  );

  expect(result.diagnostics.map((item) => item.message)).toEqual(["watch", "row"]);
});

test("vue browser API rule ignores client-only execution contexts", async () => {
  const result = await runVueSfcRuleFixture(
    noBrowserApiInSetup,
    `<script setup lang="ts">
onMounted(() => {
  document.documentElement.dataset.ready = 'true'
})

function exportImage() {
  const canvas = document.createElement('canvas')
  window.dispatchEvent(new Event('exported'))
}
</script>
<template><button @click="exportImage">Export</button></template>`,
  );

  expect(result.diagnostics).toHaveLength(0);
});

test("vue browser API rule still reports top-level setup reads", async () => {
  const result = await runVueSfcRuleFixture(
    noBrowserApiInSetup,
    `<script setup lang="ts">
const width = window.innerWidth
const root = document.documentElement
</script>`,
  );

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "vue/ssr/no-browser-api-in-setup",
    "vue/ssr/no-browser-api-in-setup",
  ]);
});

test("vue browser API rule ignores types and object event callbacks", async () => {
  const result = await runVueSfcRuleFixture(
    noBrowserApiInSetup,
    `<script setup lang="ts">
interface User { location: string }
const items = [{
  onSelect() {
    navigator.clipboard.writeText('id')
  }
}]
</script>`,
  );

  expect(result.diagnostics).toHaveLength(0);
});

test("maps eslint-plugin-vue no-mutating-props to the Doctor rule id", async () => {
  const result = await runRuleFixture({
    rule: noPropMutation,
    framework: "vue",
    files: {
      "app.vue": `<script setup lang="ts">
const props = defineProps<{ count: number }>()
props.count++
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.ruleId).toBe("vue/reactivity/no-prop-mutation");
  expect(result.diagnostics[0]!.tags).toContain("eslint-plugin-vue");
});

test("maps delegated eslint-plugin-vue rule ids to stable Doctor ids", async () => {
  const cases = [
    {
      rule: noRefAsOperand,
      id: "vue/reactivity/no-ref-as-operand",
      source: `<script setup lang="ts">
import { ref } from 'vue'
const count = ref(0)
const doubled = count + 1
</script>`,
    },
    {
      rule: computedNoSideEffects,
      id: "vue/computed/no-side-effects",
      source: `<script setup lang="ts">
import { computed, ref } from 'vue'
const count = ref(0)
const doubled = computed(() => {
  count.value++
  return count.value
})
</script>`,
    },
    {
      rule: computedNoAsync,
      id: "vue/computed/no-async",
      source: `<script setup lang="ts">
import { computed } from 'vue'
const user = computed(async () => await fetch('/api/user'))
</script>`,
    },
    {
      rule: noAfterAwait,
      id: "vue/watch/no-after-await",
      source: `<script lang="ts">
import { watch } from 'vue'
export default {
  async setup() {
    await Promise.resolve()
    watch(() => true, () => {})
  }
}
</script>`,
    },
    {
      rule: noVIfWithVFor,
      id: "vue/template/no-v-if-with-v-for",
      source: `<template>
  <li v-for="item in items" v-if="item.active">{{ item.name }}</li>
</template>`,
    },
  ];

  for (const item of cases) {
    const result = await runRuleFixture({
      rule: item.rule,
      framework: "vue",
      files: { "app.vue": item.source },
    });

    expect(result.diagnostics[0]?.ruleId).toBe(item.id);
    expect(result.diagnostics[0]?.tags).toContain("eslint-plugin-vue");
  }
});
