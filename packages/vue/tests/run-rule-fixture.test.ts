import { expect, test } from "vite-plus/test";
import {
  definePropsWatchGetter,
  noRefAsOperand,
  noBrowserApiInSetup,
  preferComposableRefReturn,
  preferDefineModel,
  preferPropsDestructureDefaults,
  preferTypeProps,
  noUntranslatedText,
  noUnusedTranslations,
  requireLifecycleCleanup,
  requirePostFlushForDomWatch,
} from "../src/rules/vue/index.ts";
import { createRule } from "../../core/src/index.ts";
import {
  runNuxtAppRuleFixture,
  runNuxtManifestRuleFixture,
  runProjectFixture,
  runRuleFixture,
  runVueSfcRuleFixture,
} from "../../core/src/testkit.ts";

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

test("vue browser API rule terminates on recursive client-only call chains", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInSetup,
    framework: "vue",
    dependencies: { "@vue/server-renderer": "^3.5.0" },
    files: {
      "app.vue": `<script setup lang="ts">
function draw() {
  window.dispatchEvent(new Event('draw'))
  update()
}

function update() {
  draw()
}
</script>
<template><button @click="update">Draw</button></template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "vue/ssr/no-browser-api-in-setup",
  ]);
});

test("vue browser API rule accepts boolean client guard identifiers", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInSetup,
    framework: "vue",
    dependencies: { "@vue/server-renderer": "^3.5.0" },
    files: {
      "src/configurable.ts": `import { isClient } from '@vueuse/shared'
export const defaultWindow = isClient ? window : undefined`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("vue browser API rule still reports top-level setup reads", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInSetup,
    framework: "vue",
    dependencies: { "@vue/server-renderer": "^3.5.0" },
    files: {
      "app.vue": `<script setup lang="ts">
const width = window.innerWidth
const root = document.documentElement
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "vue/ssr/no-browser-api-in-setup",
    "vue/ssr/no-browser-api-in-setup",
  ]);
});

test("post-flush watcher rule ignores document title writes", async () => {
  const title = await runRuleFixture({
    rule: requirePostFlushForDomWatch,
    framework: "vue",
    files: {
      "src/useTitle.ts": `const dynamicTitle = ref("")
watch(dynamicTitle, (value) => {
  document.title = value
})`,
    },
  });
  const layout = await runRuleFixture({
    rule: requirePostFlushForDomWatch,
    framework: "vue",
    files: {
      "src/useLayout.ts": `watch(width, () => {
  const box = document.querySelector('#app')?.getBoundingClientRect()
})`,
    },
  });

  expect(title.diagnostics).toHaveLength(0);
  expect(layout.diagnostics).toHaveLength(1);
});

test("lifecycle cleanup rule allows utilities to return owned resources", async () => {
  const returned = await runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "vue",
    files: {
      "src/useResize.ts": `export function useResize(el, cb) {
  const observer = new ResizeObserver((entries) => cb(entries[0].contentRect))
  observer.observe(el)
  return observer
}`,
    },
  });
  const retained = await runRuleFixture({
    rule: requireLifecycleCleanup,
    framework: "vue",
    files: {
      "src/useResize.ts": `export function useResize(el, cb) {
  const observer = new ResizeObserver((entries) => cb(entries[0].contentRect))
  observer.observe(el)
}`,
    },
  });

  expect(returned.diagnostics).toHaveLength(0);
  expect(retained.diagnostics).toHaveLength(1);
});

test("vue SSR rules are skipped for plain SPA projects", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInSetup,
    framework: "vue",
    files: {
      "src/storage.ts": `export const token = window.localStorage.getItem('token')`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("Vue version gates modern macro rules", async () => {
  const source = `<script setup lang="ts">
const props = defineProps<{ value?: string }>()
const emit = defineEmits(['update:modelValue'])
const withDefaultsProps = withDefaults(defineProps<{ label?: string }>(), { label: 'Name' })
</script>`;

  const vue33 = await runProjectFixture({
    framework: "vue",
    dependencies: { vue: "^3.3.0" },
    rules: [preferDefineModel, preferPropsDestructureDefaults],
    files: { "app.vue": source },
  });
  const vue34 = await runProjectFixture({
    framework: "vue",
    dependencies: { vue: "^3.4.0" },
    rules: [preferDefineModel, preferPropsDestructureDefaults],
    files: {
      "app.vue": `<script setup lang="ts">
defineProps(['modelValue'])
defineEmits(['update:modelValue'])
const props = withDefaults(defineProps<{ label?: string }>(), { label: 'Name' })
</script>`,
    },
  });
  const vue35 = await runProjectFixture({
    framework: "vue",
    dependencies: { vue: "^3.5.0" },
    rules: [preferDefineModel, preferPropsDestructureDefaults],
    files: {
      "app.vue": `<script setup lang="ts">
defineProps(['modelValue'])
defineEmits(['update:modelValue'])
const props = withDefaults(defineProps<{ label?: string }>(), { label: 'Name' })
</script>`,
    },
  });

  expect(vue33.diagnostics).toHaveLength(0);
  expect(vue34.diagnostics.map((item) => item.ruleId)).toEqual(["vue/style/prefer-define-model"]);
  expect(vue35.diagnostics.map((item) => item.ruleId).sort()).toEqual([
    "vue/style/prefer-define-model",
    "vue/style/prefer-props-destructure-defaults",
  ]);
});

test("prefer defineModel reports default and named v-model declarations", async () => {
  const result = await runRuleFixture({
    rule: preferDefineModel,
    framework: "vue",
    files: {
      "app.vue": `<script setup lang="ts">
defineProps({
  modelValue: String,
  title: String
})
defineEmits(['update:modelValue', 'update:title'])
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use defineModel().",
    "Use defineModel('title').",
  ]);
});

test("prefer defineModel ignores existing defineModel usage", async () => {
  const result = await runRuleFixture({
    rule: preferDefineModel,
    framework: "vue",
    files: {
      "app.vue": `<script setup lang="ts">
const model = defineModel<string>()
defineProps(['modelValue'])
defineEmits(['update:modelValue'])
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("prefer props destructure defaults can be configured off", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    rules: [preferPropsDestructureDefaults],
    config: {
      rules: {
        "vue/style/prefer-props-destructure-defaults": ["warn", { allowWithDefaults: true }],
      },
    },
    files: {
      "app.vue": `<script setup lang="ts">
const props = withDefaults(defineProps<{ label?: string }>(), { label: 'Name' })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("prefer type props reports runtime props in TypeScript script setup", async () => {
  const result = await runRuleFixture({
    rule: preferTypeProps,
    framework: "vue",
    files: {
      "app.vue": `<script setup lang="ts">
defineProps({ label: String })
</script>`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("vue/style/prefer-type-props");
});

test("prefer type props allows runtime validators when configured", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    rules: [preferTypeProps],
    config: {
      rules: {
        "vue/style/prefer-type-props": ["warn", { allowRuntimeValidators: true }],
      },
    },
    files: {
      "app.vue": `<script setup lang="ts">
defineProps({ label: String })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("prefer composable ref return reports reactive-derived object returns", async () => {
  const result = await runRuleFixture({
    rule: preferComposableRefReturn,
    framework: "vue",
    files: {
      "src/useCounter.ts": `import { reactive } from 'vue'
export function useCounter() {
  const state = reactive({ count: 0 })
  return { count: state.count }
}`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("vue/reactivity/prefer-composable-ref-return");
});

test("prefer composable ref return accepts refs and toRefs", async () => {
  const result = await runRuleFixture({
    rule: preferComposableRefReturn,
    framework: "vue",
    files: {
      "src/useRefs.ts": `import { computed, reactive, ref, toRefs } from 'vue'
export function useCount() {
  const count = ref(0)
  const doubled = computed(() => count.value * 2)
  return { count, doubled }
}
export function useState() {
  const state = reactive({ count: 0 })
  return toRefs(state)
}`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("i18n unused translations reports unused nested base locale keys", async () => {
  const result = await runRuleFixture({
    rule: noUnusedTranslations,
    framework: "vue",
    dependencies: { "vue-i18n": "^11.0.0" },
    files: {
      "src/App.vue": `<template>{{ t('common.save') }}</template>`,
      "locales/en.json": JSON.stringify({
        common: { save: "Save", cancel: "Cancel" },
      }),
      "locales/fr.json": JSON.stringify({
        common: { save: "Enregistrer", cancel: "Annuler" },
      }),
    },
  });

  expect(result.diagnostics.map((item) => item.message)).toEqual([
    'Translation key "common.cancel" is not used by any static Vue i18n call.',
  ]);
});

test("i18n unused translations accepts $t and dynamic keys stay unresolved", async () => {
  const result = await runRuleFixture({
    rule: noUnusedTranslations,
    framework: "vue",
    dependencies: { "vue-i18n": "^11.0.0" },
    files: {
      "src/App.vue": `<template>{{ $t('home.title') }} {{ t(prefix + name) }}</template>`,
      "locales/en.json": JSON.stringify({
        home: { title: "Home", dynamic: "Dynamic" },
      }),
    },
  });

  expect(result.diagnostics.map((item) => item.message)).toEqual([
    'Translation key "home.dynamic" is not used by any static Vue i18n call.',
  ]);
});

test("i18n untranslated text reports visible template text and static attributes", async () => {
  const result = await runRuleFixture({
    rule: noUntranslatedText,
    framework: "vue",
    dependencies: { "vue-i18n": "^11.0.0" },
    files: {
      "src/App.vue": `<template>
  <label>Email</label>
  <input placeholder="Email address">
  <p>{{ t('home.title') }}</p>
</template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.message)).toEqual([
    'Visible text "Email" should come from Vue i18n.',
    'Attribute "placeholder" contains untranslated text "Email address".',
  ]);
});

test("i18n unused translations reads Nuxt langDir locale files", async () => {
  const result = await runRuleFixture({
    rule: noUnusedTranslations,
    framework: "nuxt",
    dependencies: { "@nuxtjs/i18n": "^10.0.0" },
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({ i18n: { langDir: 'app/i18n' } })`,
      "app/pages/index.vue": `<template>{{ $t('home.title') }}</template>`,
      "app/i18n/en.json": JSON.stringify({
        home: { title: "Home", subtitle: "Welcome" },
      }),
    },
  });

  expect(result.diagnostics.map((item) => item.message)).toEqual([
    'Translation key "home.subtitle" is not used by any static Vue i18n call.',
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
