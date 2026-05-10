import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "pathe";
import { expect, test } from "vite-plus/test";
import { createRule, defineDoctorPlugin, runDoctor } from "../../core/src/index.ts";
import nuxtContentRulePack from "../src/rules/nuxt-content.ts";
import docusRulePack from "../src/rules/docus.ts";
import {
  noBrowserGlobalInUniversalCode,
  noBrowserSideEffectsInSetup,
  noClientConditionalInTemplate,
  noHashSensitiveRouteFullpathInSsrMarkup,
  noLegacyProcessClientServer,
  noNestedAutoimportAssumption,
  noNestedSharedAutoimportAssumption,
  noRouteObjectPageKey,
  noSubdirPluginAutoRegistrationAssumption,
  noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
  noVueOrNitroContextInShared,
  noComposableAfterAwait,
  preferEventFetch,
  forwardAuthHeadersSsr,
  noPlainEnvInAppCode,
  requireEventRuntimeConfigInServer,
  noClientComposablesInServer,
  noBrowserApiInServer,
  preferCreateUseFetch,
  createUseFetchMustBeExportedInScannedDir,
  keyedComposableRegistrationRequired,
  preferSeoComposables,
  noUnsafeUseHeadScript,
  preferUseHeadSafeForUntrustedValues,
  preferAppDirectoryPlacement,
  preferExplicitUseStateKeyInExportedComposables,
  preferNuxtPageOverRouterView,
  preferUseCookieForInitialClientState,
  requireStableAsyncDataKey,
} from "../src/rules/nuxt.ts";
import { runRuleFixture } from "../../core/src/testkit.ts";
import {
  collectNuxtDoctorRulePacks,
  resolveNuxtDoctorMcpOptions,
  writeManifest,
} from "../src/module.ts";
import { runNuxtDoctorMcpReport } from "../src/runtime/mcp/doctor.ts";
import { createRulesReport, explainRule } from "../../core/src/index.ts";
import { nuxtDoctorPlugins, nuxtRulePacks } from "../src/rules/index.ts";

const cases = [
  {
    rule: noBrowserGlobalInUniversalCode,
    id: "nuxt/hydration/no-browser-global-in-universal-code",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">const width = window.innerWidth</script>`,
  },
  {
    rule: noClientConditionalInTemplate,
    id: "nuxt/hydration/no-client-conditional-in-template",
    file: "app/pages/index.vue",
    source: `<template><div v-if="import.meta.client">client</div></template>`,
  },
  {
    rule: preferUseCookieForInitialClientState,
    id: "nuxt/hydration/prefer-usecookie-for-initial-client-state",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">const theme = localStorage.getItem('theme')</script>`,
  },
  {
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    id: "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">const now = Date.now()</script>`,
  },
  {
    rule: preferNuxtPageOverRouterView,
    id: "nuxt/routing/prefer-nuxtpage-over-routerview",
    file: "app/app.vue",
    source: `<template><RouterView /></template>`,
  },
  {
    rule: noRouteObjectPageKey,
    id: "nuxt/routing/no-route-object-page-key",
    file: "app/app.vue",
    source: `<template><NuxtPage :page-key="$route.fullPath" /></template>`,
  },
  {
    rule: noHashSensitiveRouteFullpathInSsrMarkup,
    id: "nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup",
    file: "app/pages/index.vue",
    source: `<template><p>{{ route.fullPath }}</p></template>`,
  },
  {
    rule: noLegacyProcessClientServer,
    id: "nuxt/context/no-legacy-process-client-server",
    file: "app/plugins/demo.ts",
    source: `if (process.client) console.log('client')`,
  },
  {
    rule: preferAppDirectoryPlacement,
    id: "nuxt/project/prefer-app-directory-placement",
    file: "pages/index.vue",
    source: `<template><div /></template>`,
  },
  {
    rule: noNestedAutoimportAssumption,
    id: "nuxt/composables/no-nested-autoimport-assumption",
    file: "app/composables/nested/useThing.ts",
    source: `export function useThing() { return true }`,
  },
  {
    rule: noVueOrNitroContextInShared,
    id: "nuxt/shared/no-vue-or-nitro-context-in-shared",
    file: "shared/utils/state.ts",
    source: `import { ref } from 'vue'\nexport const value = ref(1)`,
  },
  {
    rule: noNestedSharedAutoimportAssumption,
    id: "nuxt/shared/no-nested-shared-autoimport-assumption",
    file: "shared/utils/nested/math.ts",
    source: `export const one = 1`,
  },
  {
    rule: noSubdirPluginAutoRegistrationAssumption,
    id: "nuxt/plugins/no-subdir-auto-registration-assumption",
    file: "app/plugins/nested/analytics.ts",
    source: `export default defineNuxtPlugin(() => {})`,
  },
  {
    rule: requireStableAsyncDataKey,
    id: "nuxt/fetch/require-stable-asyncdata-key",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">await useAsyncData(() => $fetch('/api/user'))</script>`,
  },
  {
    rule: preferExplicitUseStateKeyInExportedComposables,
    id: "nuxt/state/prefer-explicit-usestate-key-in-exported-composables",
    file: "app/composables/useCounter.ts",
    source: `export function useCounter() { return useState(() => 0) }`,
  },
  {
    rule: noComposableAfterAwait,
    id: "nuxt/context/no-composable-after-await",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">await foo(); useRuntimeConfig()</script>`,
  },
  {
    rule: preferEventFetch,
    id: "nuxt/server/prefer-event-fetch",
    file: "server/api/user.ts",
    source: `export default defineEventHandler((event) => $fetch('/api/team'))`,
  },
  {
    rule: forwardAuthHeadersSsr,
    id: "nuxt/fetch/forward-auth-headers-ssr",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">const user = await $fetch('/api/user')</script>`,
  },
  {
    rule: noPlainEnvInAppCode,
    id: "nuxt/runtime/no-plain-env-in-app-code",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">const key = process.env.API_KEY</script>`,
  },
  {
    rule: requireEventRuntimeConfigInServer,
    id: "nuxt/runtime/require-event-runtime-config-in-server",
    file: "server/api/user.ts",
    source: `export default defineEventHandler((event) => useRuntimeConfig())`,
  },
  {
    rule: noClientComposablesInServer,
    id: "nuxt/server/no-client-composables",
    file: "server/api/user.ts",
    source: `export default defineEventHandler(() => useRoute())`,
  },
  {
    rule: noBrowserApiInServer,
    id: "nuxt/server/no-browser-api",
    file: "server/api/user.ts",
    source: `export default defineEventHandler(() => window.location.href)`,
  },
  {
    rule: preferCreateUseFetch,
    id: "nuxt/fetch/prefer-create-use-fetch",
    file: "app/composables/useUser.ts",
    source: `export function useUser() { return useFetch('/api/user') }`,
  },
  {
    rule: createUseFetchMustBeExportedInScannedDir,
    id: "nuxt/fetch/create-usefetch-must-be-exported-in-scanned-dir",
    file: "app/composables/nested/useUser.ts",
    source: `const useUser = createUseFetch('/api/user')`,
  },
  {
    rule: keyedComposableRegistrationRequired,
    id: "nuxt/fetch/keyed-composable-registration-required",
    file: "app/composables/useUser.ts",
    source: `export const useUser = createUseFetch('/api/user')`,
  },
  {
    rule: preferSeoComposables,
    id: "nuxt/seo/prefer-seo-composables",
    file: "app/utils/seo.ts",
    source: `useHead({ title: 'Home', meta: [] })`,
  },
  {
    rule: noUnsafeUseHeadScript,
    id: "nuxt/security/no-unsafe-usehead-script",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">useHead({ script: [{ innerHTML: code }] })</script>`,
  },
  {
    rule: preferUseHeadSafeForUntrustedValues,
    id: "nuxt/security/prefer-useheadsafe-for-untrusted-values",
    file: "app/pages/index.vue",
    source: `<script setup lang="ts">const route = useRoute(); useHead({ title: route.query.title })</script>`,
  },
];

for (const item of cases) {
  test(item.id, async () => {
    const result = await runRuleFixture({
      rule: item.rule,
      framework: "nuxt",
      files: { [item.file]: item.source },
    });

    expect(result.diagnostics[0]?.ruleId).toBe(item.id);
  });
}

test("browser globals inside client-only callbacks are not reported", async () => {
  const files = {
    "app/app.vue": `<script setup lang="ts">
onKeyDown('/', e => {
  const searchInput = document.querySelector<HTMLInputElement>('input[type="search"]')
  searchInput?.focus()
})

if (import.meta.client) {
  useEventListener(document, 'click', () => {})
}
</script>`,
    "app/components/Brand/Customize.vue": `<script setup lang="ts">
async function downloadCustomPng() {
  await document.fonts.ready
  const canvas = document.createElement('canvas')
}
</script>
<template><button @click="downloadCustomPng">Download</button></template>`,
    "app/components/CallToAction.vue": `<script setup lang="ts">
function handleCardClick(event: MouseEvent) {
  const selection = window.getSelection()
  if (selection?.type === 'Range') return
}
</script>
<template><article @click="handleCardClick" /></template>`,
    "app/components/CollapsibleSection.vue": `<script setup lang="ts">
onPrehydrate(() => {
  const settings = JSON.parse(localStorage.getItem('npmx-settings') || '{}')
  document.documentElement.dataset.collapsed = settings.collapsed
})

onMounted(() => {
  document.documentElement.dataset.ready = 'true'
})
</script>`,
  };

  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files,
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("browser side effects and storage reads inside client-only callbacks are not reported", async () => {
  const files = {
    "app/components/ClientOnlyWork.vue": `<script setup lang="ts">
onMounted(() => {
  localStorage.setItem('theme', 'dark')
})

onPrehydrate(() => {
  const theme = localStorage.getItem('theme')
  document.documentElement.dataset.theme = theme || 'system'
})
</script>`,
  };

  const sideEffects = await runRuleFixture({
    rule: noBrowserSideEffectsInSetup,
    framework: "nuxt",
    files,
  });
  const storage = await runRuleFixture({
    rule: preferUseCookieForInitialClientState,
    framework: "nuxt",
    files,
  });

  expect(sideEffects.diagnostics).toHaveLength(0);
  expect(storage.diagnostics).toHaveLength(0);
});

test("top-level browser and time-dependent setup values are still reported", async () => {
  const browser = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
const width = window.innerWidth
const title = document.title
const theme = localStorage.getItem('theme')
</script>`,
    },
  });
  const storage = await runRuleFixture({
    rule: preferUseCookieForInitialClientState,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">const theme = localStorage.getItem('theme')</script>`,
    },
  });
  const time = await runRuleFixture({
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
const now = Date.now()
const id = Math.random()
const date = new Date()
</script>`,
    },
  });

  expect(browser.diagnostics.map((item) => item.ruleId)).toContain(
    "nuxt/hydration/no-browser-global-in-universal-code",
  );
  expect(storage.diagnostics).toHaveLength(1);
  expect(time.diagnostics).toHaveLength(3);
});

test("type-only, server, and client callback contexts do not create hydration noise", async () => {
  const browser = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/types/index.d.ts": `export interface User { location: string }`,
      "app/pages/customers.vue": `<script setup lang="ts">
const items = [{
  label: 'Copy',
  onSelect() {
    navigator.clipboard.writeText('id')
  }
}]
const columns = [{
  accessorKey: 'location',
  cell: ({ row }) => row.original.location
}]
</script>`,
      "shared/utils/tools/weather.ts": `const weatherTool = {
  execute: async ({ location }: { location: string }) => ({ location })
}`,
      "app/components/Observed.vue": `<script setup lang="ts">
const target = useTemplateRef('target')
useIntersectionObserver(target, () => {
  const observer = new IntersectionObserver(() => {})
})
useResizeObserver(target, () => {
  const width = window.innerWidth
})
onMounted(() => {
  function resize() {
    const dpr = window.devicePixelRatio
  }
  resize()
})
</script>`,
      "app/composables/useFilters.ts": `<script setup lang="ts">
const rows = [{ location: { key: 'us' } }]
const locations = computed(() => rows
  .map(row => row.location)
  .filter((location): location is { key: string } => location !== null)
  .map((location) => location.key))
</script>`,
      "app/components/ThemePicker.vue": `<script setup lang="ts">
const theme = computed({
  get() {
    return 'dark'
  },
  set(value) {
    window.localStorage.setItem('theme', value)
  }
})
</script>`,
      "app/pages/article.vue": `<script setup lang="ts">
defineShortcuts({
  meta_k: {
    handler: () => {
      navigator.clipboard.writeText(window.location.href)
    }
  }
})
</script>`,
      "app/utils/browser.ts": `export function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

export function sendWhenHidden() {
  if (isBrowser() && document.visibilityState === 'hidden') {
    navigator.sendBeacon('/log', 'ok')
  }
}`,
    },
  });
  const time = await runRuleFixture({
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    framework: "nuxt",
    files: {
      "server/api/mails.ts": `export default defineEventHandler(() => ({ id: Date.now() }))`,
      "app/pages/index.vue": `<script setup lang="ts">const now = Date.now()</script>`,
    },
  });

  expect(browser.diagnostics).toHaveLength(0);
  expect(time.diagnostics).toHaveLength(1);
  expect(time.diagnostics[0]?.file).toContain("app/pages/index.vue");
});

test("module packs activate from dependencies", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup lang="ts">queryContent('/docs')</script>`,
    },
    { "@nuxt/content": "^3.0.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [
          defineDoctorPlugin({
            name: "fixture",
            rulePacks: [nuxtContentRulePack],
          }),
        ],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "nuxt-content/no-querycontent-legacy-api",
      ]);
    },
  );
});

test("module packs stay inactive when dependency is absent", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup lang="ts">queryContent('/docs')</script>`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [
          defineDoctorPlugin({
            name: "fixture",
            rulePacks: [nuxtContentRulePack],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("Docus content links report missing internal to targets", async () => {
  await withFixture(
    {
      "content/index.md": `:u-button{to="/vue" label="Vue"}\n:u-button{to="https://example.com" label="External"}`,
      "content/1.vue/index.md": `::u-page-card\n---\nto: /vue/rules\n---\n::`,
      "content/1.vue/3.rules.md": `# Vue rules`,
      "content/2.nuxt/2.getting-started.md": `# Getting started`,
      "content/2.nuxt/index.md": `:u-button{to="/nuxt/getting-started#install" label="Start"}`,
      "content/3.bad/index.md": `::u-page-card\n---\nto: /missing\n---\n::`,
    },
    { docus: "^5.8.0", "@nuxt/content": "^3.0.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [defineDoctorPlugin({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "nuxt-content/links/no-broken-internal-to-link",
      ]);
      expect(result.diagnostics[0]?.message).toContain("/missing");
    },
  );
});

test("Docus app.vue shadow rule reports empty local app shell only", async () => {
  await withFixture(
    {
      "app/app.vue": `<template><NuxtPage /></template>`,
    },
    { docus: "^5.8.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [defineDoctorPlugin({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "docus/layers/no-empty-app-vue-shadow",
      ]);
    },
  );

  await withFixture(
    {
      "app/app.vue": `<script setup>const locale = useState('locale')</script><template><UApp><AppHeader /><NuxtPage /></UApp></template>`,
    },
    { docus: "^5.8.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [defineDoctorPlugin({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("Docus app config rule reports unknown top-level keys", async () => {
  await withFixture(
    {
      "app/app.config.ts": `export default defineAppConfig({
  docus: { locale: 'en' },
  header: { title: 'Vue Doctor' },
  navigation: { sub: 'header' },
  github: { url: 'https://github.com/onmax/nuxt-doctor', branch: 'main', rootDir: 'docs' },
  assistant: { explainWithAi: false },
  toc: { title: 'On This Page' },
  ui: { colors: { primary: 'emerald' } },
  docsModules: ['vue', 'nuxt'],
})`,
    },
    { docus: "^5.8.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [defineDoctorPlugin({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "docus/appconfig/no-unknown-key",
      ]);
      expect(result.diagnostics[0]?.message).toContain("docsModules");
    },
  );
});

test("Docus rule pack activates from static extends and stays inactive without Docus", async () => {
  await withFixture(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ['docus'] })`,
      "app/app.config.ts": `export default defineAppConfig({ docsModules: ['vue'] })`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [defineDoctorPlugin({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "docus/appconfig/no-unknown-key",
      ]);
    },
  );

  await withFixture(
    {
      "app/app.config.ts": `export default defineAppConfig({ docsModules: ['vue'] })`,
    },
    { "@nuxt/content": "^3.0.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [defineDoctorPlugin({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("NuxtManifest visitors run once per rule", async () => {
  await withFixture(
    {
      "app/pages/one.vue": `<template><div /></template>`,
      "app/pages/two.vue": `<template><div /></template>`,
      "app/composables/nested/useThing.ts": `export function useThing() { return true }`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [
          defineDoctorPlugin({
            name: "fixture",
            rulePacks: [
              {
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
              },
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(1);
    },
  );
});

test("manifest import dirs suppress configured nested composable warning", async () => {
  await withFixture(
    {
      "app/composables/nested/useThing.ts": `export function useThing() { return true }`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        importsDirs: [join(root, "app/composables/nested")],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [
          defineDoctorPlugin({
            name: "fixture",
            rulePacks: [
              { name: "fixture", version: "0.0.0", rules: [noNestedAutoimportAssumption] },
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("manifest plugin files suppress configured nested plugin warning", async () => {
  await withFixture(
    {
      "app/plugins/nested/analytics.ts": `export default defineNuxtPlugin(() => {})`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        pluginFiles: [join(root, "app/plugins/nested/analytics.ts")],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [
          defineDoctorPlugin({
            name: "fixture",
            rulePacks: [
              {
                name: "fixture",
                version: "0.0.0",
                rules: [noSubdirPluginAutoRegistrationAssumption],
              },
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("Nuxt module writes manifest and accepts context hook contributions", async () => {
  await withFixture({}, {}, async (root) => {
    const nuxt = {
      options: { rootDir: root, buildDir: ".nuxt", modules: [] },
      async callHook(name: string, payload: any) {
        if (name !== "doctor:context") return;
        payload.manifest.modules.push({ name: "fixture-module", doctorPlugin: "fixture" });
      },
    };

    await writeManifest(nuxt);

    const manifestPath = join(root, ".nuxt/doctor.manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.modules.some((module: any) => module.name === "fixture-module")).toBe(true);
  });
});

test("Nuxt module writes manifest source hook contributions", async () => {
  await withFixture({}, {}, async (root) => {
    const moduleRoot = join(root, "node_modules/fixture-module/runtime");
    const nuxt = {
      options: { rootDir: root, buildDir: ".nuxt", modules: [] },
      async callHook(name: string, payload: any[]) {
        if (name !== "doctor:extendSources") return;
        payload.push({
          module: "fixture-module",
          root: moduleRoot,
          packageDir: resolve(moduleRoot, ".."),
          include: ["**/*.{vue,ts}"],
          runtimeDirs: [moduleRoot],
        });
      },
    };

    await writeManifest(nuxt);

    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.moduleSources).toEqual([
      {
        module: "fixture-module",
        root: moduleRoot,
        packageDir: resolve(moduleRoot, ".."),
        include: ["**/*.{vue,ts}"],
        runtimeDirs: [moduleRoot],
      },
    ]);
  });
});

test("third-party Nuxt rule hook contributions are collected", async () => {
  await withFixture(
    { "app/pages/index.vue": `<script setup>const ok = true</script>` },
    {},
    async (root) => {
      const hookRule = createRule({
        meta: {
          id: "fixture/nuxt-hook-rule",
          title: "Nuxt hook rule",
          category: "architecture",
          severity: "error",
          requires: { script: true, nuxt: true },
        },
        create(ctx) {
          return {
            ScriptNode(node: any) {
              if (node.type !== "Program") return;
              ctx.report({
                ruleId: "fixture/nuxt-hook-rule",
                severity: "error",
                category: "architecture",
                file: ctx.file.path,
                message: "Hook rule ran.",
              });
            },
          };
        },
      });

      const rulePacks = await collectNuxtDoctorRulePacks({
        async callHook(name: string, packs: any[]) {
          if (name !== "doctor:extendRules") return;
          packs.push({ name: "fixture", version: "0.0.0", rules: [hookRule] });
        },
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [defineDoctorPlugin({ name: "fixture", rulePacks })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toContain("fixture/nuxt-hook-rule");
    },
  );
});

test("Nuxt Doctor MCP options default on and can be disabled or customized", () => {
  expect(resolveNuxtDoctorMcpOptions(true)).toMatchObject({
    route: "/mcp",
    name: "Nuxt Doctor",
  });
  expect(resolveNuxtDoctorMcpOptions(undefined)).toMatchObject({
    route: "/mcp",
    name: "Nuxt Doctor",
  });
  expect(resolveNuxtDoctorMcpOptions(false)).toBe(false);
  expect(resolveNuxtDoctorMcpOptions({ route: "/api/mcp", name: "Fixture Doctor" })).toMatchObject({
    route: "/api/mcp",
    name: "Fixture Doctor",
  });
});

test("Nuxt Doctor MCP tools expose stable read-only names", () => {
  const reportTool = readFileSync(resolve("src/runtime/mcp/tools/doctor-report.ts"), "utf8");
  const rulesTool = readFileSync(resolve("src/runtime/mcp/tools/doctor-rules.ts"), "utf8");
  const explainTool = readFileSync(resolve("src/runtime/mcp/tools/doctor-explain-rule.ts"), "utf8");

  expect(reportTool).toContain('name: "doctor_report"');
  expect(rulesTool).toContain('name: "doctor_rules"');
  expect(explainTool).toContain('name: "doctor_explain_rule"');
  expect(reportTool).toContain("readOnlyHint: true");
  expect(rulesTool).toContain("readOnlyHint: true");
  expect(explainTool).toContain("readOnlyHint: true");
});

test("Nuxt Doctor MCP report scans the current project root", async () => {
  const root = resolve("fixtures/nuxt-all-issues");
  const result = await runNuxtDoctorMcpReport(
    {
      rootDir: root,
      async getRulePacks() {
        return [];
      },
    },
    { rules: "nuxt/fetch/no-raw-fetch-in-setup" },
  );

  expect(result.root).toBe(root);
  expect(result.summary.error + result.summary.warn + result.summary.blocker).toBeGreaterThan(0);
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(
    "nuxt/fetch/no-raw-fetch-in-setup",
  );
});

test("Nuxt Doctor MCP rule payloads use JSON report helpers", () => {
  const rules = JSON.parse(createRulesReport(nuxtRulePacks(), "json"));
  expect(rules.rules.map((rule: any) => rule.pack)).toEqual(
    expect.arrayContaining([
      "nuxt-doctor/nuxt",
      "nuxt-doctor/nuxt-content",
      "nuxt-doctor/nuxt-ui",
      "nuxt-doctor/nuxt-scripts",
      "nuxt-doctor/vueuse",
      "nuxt-doctor/nuxt-image",
      "nuxt-doctor/nuxthub",
      "nuxt-doctor/nuxt-better-auth",
      "nuxt-doctor/docus",
    ]),
  );

  const explanation = JSON.parse(
    explainRule(nuxtRulePacks(), "nuxt/fetch/no-raw-fetch-in-setup", "json"),
  );
  expect(explanation.id).toBe("nuxt/fetch/no-raw-fetch-in-setup");
  expect(JSON.parse(explainRule(nuxtRulePacks(), "nuxt/does-not-exist", "json"))).toEqual({
    rule: null,
  });
});

test("explicit Nuxt module sources are scanned with module metadata", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup>const ok = true</script>`,
      "node_modules/unscanned-module/runtime/Bad.vue": `<script setup>const width = window.innerWidth</script>`,
      "node_modules/fixture-module/runtime/Bad.vue": `<script setup>const width = window.innerWidth</script>`,
      "node_modules/fixture-module/runtime/useBad.ts": `export function useBad() { return window.innerWidth }`,
    },
    {},
    async (root) => {
      const moduleRoot = join(root, "node_modules/fixture-module/runtime");
      const moduleRule = createRule({
        meta: {
          id: "fixture/module-source",
          title: "Module source",
          category: "architecture",
          severity: "error",
          requires: { script: true, nuxt: true },
        },
        create(ctx) {
          return {
            ScriptNode(node: any) {
              if (node.type !== "Program" || !ctx.file.isModuleSource()) return;
              ctx.report({
                ruleId: "fixture/module-source",
                severity: "error",
                category: "architecture",
                file: ctx.file.path,
                message: `${ctx.file.moduleName}:${ctx.file.relativePath}`,
              });
            },
          };
        },
      });

      await writeFileManifest(root, [
        {
          module: "fixture-module",
          root: moduleRoot,
          packageDir: join(root, "node_modules/fixture-module"),
          include: ["**/*.{vue,ts}"],
        },
      ]);

      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [
          defineDoctorPlugin({
            name: "fixture",
            rulePacks: [{ name: "fixture", version: "0.0.0", rules: [moduleRule] }],
          }),
        ],
      });

      expect(result.diagnostics.map((item) => item.message).sort()).toEqual([
        "fixture-module:fixture-module:Bad.vue",
        "fixture-module:fixture-module:useBad.ts",
      ]);
      expect(result.diagnostics.some((item) => item.file.includes("unscanned-module"))).toBe(false);
    },
  );
});

test("default Nuxt scans do not traverse node_modules source", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup>const ok = true</script>`,
      "node_modules/unscanned-module/runtime/Bad.vue": `<script setup>const width = window.innerWidth</script>`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: [
          defineDoctorPlugin({
            name: "fixture",
            rulePacks: [
              {
                name: "fixture",
                version: "0.0.0",
                rules: [noBrowserGlobalInUniversalCode],
              },
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("built-in Nuxt app rule packs skip explicit module sources", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup>const ok = true</script>`,
      "node_modules/fixture-module/runtime/Bad.vue": `<script setup>const width = window.innerWidth</script>`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [
        {
          module: "fixture-module",
          root: join(root, "node_modules/fixture-module/runtime"),
          include: ["**/*.{vue,ts}"],
        },
      ]);

      const result = await runDoctor({
        root,
        framework: "nuxt",
        plugins: nuxtDoctorPlugins(),
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("nuxt-doctor exits 1 for errors and 0 for warnings unless max warnings is zero", async () => {
  await withFixture(
    {
      "app/pages/error.vue": `<script setup>const width = window.innerWidth</script>`,
      "app/pages/warn.vue": `<script setup>const theme = localStorage.getItem('theme')</script>`,
    },
    {},
    async (root) => {
      const cli = join(process.cwd(), "dist/bin.mjs");
      expect(
        (await runCli(cli, [root, "--rules", "nuxt/hydration/no-browser-global-in-universal-code"]))
          .code,
      ).toBe(1);
      expect(
        (
          await runCli(cli, [
            root,
            "--rules",
            "nuxt/hydration/prefer-usecookie-for-initial-client-state",
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await runCli(cli, [
            root,
            "--rules",
            "nuxt/hydration/prefer-usecookie-for-initial-client-state",
            "--max-warnings",
            "0",
          ])
        ).code,
      ).toBe(1);
    },
  );
}, 15000);

async function withFixture(
  files: Record<string, string>,
  dependencies: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "vue-doctor-modern-nuxt-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies: { vue: "^3.5.0", nuxt: "^4.0.0", ...dependencies },
      }),
    );
    for (const [file, text] of Object.entries(files)) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFileManifest(
  root: string,
  moduleSources: any[],
  extra: Record<string, unknown> = {},
) {
  const buildDir = join(root, ".nuxt");
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(
    join(buildDir, "doctor.manifest.json"),
    JSON.stringify(
      {
        nuxtVersion: "4",
        vueVersion: "3.5",
        rootDir: root,
        srcDir: root,
        appDir: join(root, "app"),
        buildDir,
        autoImports: [],
        components: [],
        layers: [{ root, priority: 0 }],
        aliases: {},
        routeRules: {},
        serverHandlers: [],
        modules: [],
        moduleSources,
        ...extra,
      },
      null,
      2,
    ),
  );
}

const execFileAsync = promisify(execFile);

async function runCli(cli: string, args: string[]) {
  try {
    await execFileAsync("node", [cli, ...args]);
    return { code: 0 };
  } catch (error: any) {
    return { code: error.code ?? 1 };
  }
}
