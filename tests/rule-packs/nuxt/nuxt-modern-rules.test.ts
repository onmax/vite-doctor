import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
  runDoctor,
} from "../../../src/core/index.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/rules.ts";
import nuxtContentRulePack from "../../../src/rule-packs/nuxt/rules/nuxt-content.ts";
import docusRulePack from "../../../src/rule-packs/nuxt/rules/docus.ts";
import { preferUButton, preferUFormControls } from "../../../src/rule-packs/nuxt/rules/nuxt-ui.ts";
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
  noRouteMiddlewareApiSecurity,
  noVueOrNitroContextInShared,
  noComposableAfterAwait,
  forwardAuthHeadersSsr,
  noPlainEnvInAppCode,
  preferCreateUseFetch,
  createUseFetchMustBeExportedInScannedDir,
  keyedComposableRegistrationRequired,
  preferSeoComposables,
  noUnsafeUseHeadScript,
  preferUseHeadSafeForUntrustedValues,
  preferAppDirectoryPlacement,
  preferExplicitUseStateKeyInExportedComposables,
  preferNuxtLink,
  preferNuxtPageOverRouterView,
  preferUseCookieForInitialClientState,
  noNonSerializableUseState,
  requireStableAsyncDataKey,
  asyncDataNoMutationMethods,
  noManualActionUseFetch,
  asyncDataHandlerPure,
  previewModeGlobalRefresh,
  noGlobalRefreshWithoutJustification,
  asyncDataExplicitKeyForRefreshable,
  postFetchRequiresReadonlyMarker,
  noMutationToastInUseFetchCallback,
  noExplicitAutoImport,
} from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import {
  noBrowserApiInServer,
  noClientComposablesInServer,
  preferAssertMethod,
  preferRouteMethodSuffix,
  preferGetRequestIp,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
  requireEventRuntimeConfigInServer,
} from "../../../src/rule-packs/nitro/rules.ts";
import { runProjectFixture, runRuleFixture } from "../../../src/core/testkit.ts";
import nuxtDoctorModule, {
  collectNuxtDoctorRulePacks,
  writeManifest,
} from "../../../src/rule-packs/nuxt/module.ts";
import { createRulesReport, createTextReport, explainRule } from "../../../src/core/index.ts";
import {
  nitroRulePack,
  nuxtDoctorExtensions,
  nuxtRulePacks,
} from "../../../src/rule-packs/nuxt/rules/index.ts";
import { createNuxtRuntimeEvidence } from "../../../src/rule-packs/nuxt/rules/nuxt/evidence.ts";
import { main } from "../../../src/cli.ts";
import {
  htmlButtonHasType,
  preferSameNamePropShorthand,
  preferTrueAttributeShorthand,
} from "../../../src/rule-packs/vue/rules/vue/index.ts";
import {
  preferUseEventListener,
  preferUseObservers,
  preferUseScrollAndElement,
  preferUseStorage,
  preferUseTimers,
} from "../../../src/rule-packs/nuxt/rules/vueuse.ts";

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
    source: `<template>{{ now }}</template><script setup lang="ts">const now = Date.now()</script>`,
  },
  {
    rule: preferNuxtPageOverRouterView,
    id: "nuxt/routing/prefer-nuxtpage-over-routerview",
    file: "app/app.vue",
    source: `<template><RouterView /></template>`,
  },
  {
    rule: preferNuxtLink,
    id: "nuxt/routing/prefer-nuxtlink",
    file: "app/pages/index.vue",
    source: `<template><a href="/about">About</a></template>`,
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
    file: "app/composables/useUser.ts",
    source: `export function useUser() { return useAsyncData(() => $fetch('/api/user')) }`,
  },
  {
    rule: asyncDataNoMutationMethods,
    id: "nuxt/async-data-no-mutation-methods",
    file: "app/pages/settings.vue",
    source: `<script setup lang="ts">useFetch('/api/settings', { method: 'PATCH' })</script>`,
  },
  {
    rule: noManualActionUseFetch,
    id: "nuxt/no-manual-action-usefetch",
    file: "app/pages/settings.vue",
    source: `<script setup lang="ts">const { execute } = useLazyFetch('/api/settings', { method: 'PATCH', immediate: false })</script>`,
  },
  {
    rule: asyncDataHandlerPure,
    id: "nuxt/async-data-handler-pure",
    file: "app/pages/settings.vue",
    source: `<script setup lang="ts">useAsyncData('settings', () => $fetch('/api/settings', { method: 'put' }))</script>`,
  },
  {
    rule: previewModeGlobalRefresh,
    id: "nuxt/preview-mode-global-refresh",
    file: "app/plugins/preview.ts",
    source: `usePreviewMode({ shouldEnable: () => import.meta.dev })`,
  },
  {
    rule: noGlobalRefreshWithoutJustification,
    id: "nuxt/no-global-refresh-without-justification",
    file: "app/plugins/refresh.ts",
    source: `export default defineNuxtPlugin(() => refreshNuxtData())`,
  },
  {
    rule: asyncDataExplicitKeyForRefreshable,
    id: "nuxt/async-data-explicit-key-for-refreshable",
    file: "app/pages/settings.vue",
    source: `<script setup lang="ts">const { refresh } = useFetch('/api/settings')</script>`,
  },
  {
    rule: postFetchRequiresReadonlyMarker,
    id: "nuxt/post-fetch-requires-readonly-marker",
    file: "app/pages/settings.vue",
    source: `<script setup lang="ts">useFetch('/api/settings/update', { method: 'POST', body })</script>`,
  },
  {
    rule: noMutationToastInUseFetchCallback,
    id: "nuxt/no-mutation-toast-in-usefetch-callback",
    file: "app/pages/settings.vue",
    source: `<script setup lang="ts">useLazyFetch('/api/settings', { method: 'PATCH', onResponse() { toast.add({ title: 'Saved' }) } })</script>`,
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
    source: `<script setup lang="ts">async function load() { await foo(); useRuntimeConfig() }</script>`,
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
    id: "nitro/runtime/require-event-runtime-config-in-server",
    file: "server/api/user.ts",
    source: `export default defineEventHandler((event) => useRuntimeConfig())`,
  },
  {
    rule: noClientComposablesInServer,
    id: "nitro/server/no-client-composables",
    file: "server/api/user.ts",
    source: `export default defineEventHandler(() => useRoute())`,
  },
  {
    rule: noBrowserApiInServer,
    id: "nitro/server/no-browser-api",
    file: "server/api/user.ts",
    source: `export default defineEventHandler(() => window.location.href)`,
  },
  {
    rule: preferRouteMethodSuffix,
    id: "nitro/request/prefer-route-method-suffix",
    file: "server/api/user.ts",
    source: `export default defineEventHandler((event) => {
  if (getMethod(event) !== 'POST') throw createError({ statusCode: 405 })
  return {}
})`,
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

test("nuxt/context/no-legacy-process-client-server activates for compatibility 5", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [noLegacyProcessClientServer],
    run: {
      runtimeTarget: {
        nuxt: "4.2.0",
        nitro: "2.12.0",
        h3: "1.15.4",
        vue: "3.5.0",
        nuxtCompatibility: 5,
      },
    },
    files: { "app/plugins/demo.ts": `if (process.client) console.log('client')` },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "nuxt/context/no-legacy-process-client-server",
  ]);
});

test("unsafe useHead script ignores style innerHTML", async () => {
  const result = await runRuleFixture({
    rule: noUnsafeUseHeadScript,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
useHead({
  style: [{ innerHTML: ':root { color-scheme: dark; }' }],
})
</script>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("unsafe useHead script ignores JSON-LD data scripts", async () => {
  const result = await runRuleFixture({
    rule: noUnsafeUseHeadScript,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
useHead({
  script: [{ type: 'application/ld+json', innerHTML: JSON.stringify(schema) }],
})
</script>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("unsafe useHead script ignores mapped JSON-LD data scripts", async () => {
  const result = await runRuleFixture({
    rule: noUnsafeUseHeadScript,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
useHead({
  script: schemas.map((schema) => ({
    type: 'application/ld+json',
    innerHTML: JSON.stringify(schema),
  })),
})
</script>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("same-name prop shorthand reports matching prop bindings", async () => {
  const result = await runRuleFixture({
    rule: preferSameNamePropShorthand,
    framework: "vue",
    files: {
      "app.vue": `<template>
  <MyCmp :my-prop="myProp" :user="user" v-bind:account-id="accountId" />
</template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.message)).toEqual([
    "Use Vue's same-name prop shorthand for my-prop.",
    "Use Vue's same-name prop shorthand for user.",
    "Use Vue's same-name prop shorthand for account-id.",
  ]);
});

test("same-name prop shorthand ignores unclear prop bindings", async () => {
  const result = await runRuleFixture({
    rule: preferSameNamePropShorthand,
    framework: "vue",
    files: {
      "app.vue": `<template>
  <MyCmp
    :my-prop="value"
    :other-prop="props.otherProp"
    :count="getCount()"
    :[name]="name"
    v-bind="attrs"
    :already-shorthand
  />
</template>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("same-name prop shorthand provides suggestion fixes", async () => {
  const result = await runRuleFixture({
    rule: preferSameNamePropShorthand,
    framework: "vue",
    files: {
      "app.vue": `<template><MyCmp :my-prop="myProp" v-bind:user="user" /></template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.fix)).toEqual([
    {
      kind: "suggestion",
      edits: [{ range: expect.any(Object), text: "" }],
    },
    {
      kind: "suggestion",
      edits: [{ range: expect.any(Object), text: "" }],
    },
  ]);
});

test("native buttons require explicit type", async () => {
  const result = await runRuleFixture({
    rule: htmlButtonHasType,
    framework: "vue",
    files: {
      "app.vue": `<template>
  <button @click="save">Save</button>
  <button type="button">Cancel</button>
  <button type="submit">Submit</button>
  <button :type="kind">Dynamic</button>
  <UButton>UI</UButton>
</template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "vue/template/html-button-has-type",
  ]);
  expect(result.diagnostics[0]?.fix).toEqual({
    kind: "suggestion",
    edits: [{ range: expect.any(Object), text: ' type="button"' }],
  });
});

test("true attribute shorthand reports only native boolean attributes", async () => {
  const result = await runRuleFixture({
    rule: preferTrueAttributeShorthand,
    framework: "vue",
    files: {
      "app.vue": `<template>
  <button :disabled="true">Save</button>
  <input :checked="isChecked">
  <MyCmp :enabled="true" />
</template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "vue/template/prefer-true-attribute-shorthand",
  ]);
  expect(result.diagnostics[0]?.fix).toEqual({
    kind: "suggestion",
    edits: [{ range: expect.any(Object), text: "disabled" }],
  });
});

test("async data mutation rule resolves lowercase and enum-like methods", async () => {
  const result = await runRuleFixture({
    rule: asyncDataNoMutationMethods,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
useFetch('/api/a', { method: 'patch' })
useLazyFetch('/api/b', { method: HttpMethod.DELETE })
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.severity)).toEqual(["error", "error"]);
});

test("POST async data reports write-like paths but ignores read-like POST queries", async () => {
  const result = await runRuleFixture({
    rule: postFetchRequiresReadonlyMarker,
    framework: "nuxt",
    files: {
      "app/pages/search.vue": `<script setup lang="ts">
useFetch('/api/rules/query', {
  method: 'POST',
  body,
})
useFetch('/api/search', {
  method: 'POST',
  meta: { readonly: true },
  body,
})
useFetch('/api/settings', { method: 'POST', body })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.severity).toBe("error");
});

test("POST async data ignores query-like paths unless they contain write-like segments", async () => {
  const result = await runRuleFixture({
    rule: postFetchRequiresReadonlyMarker,
    framework: "nuxt",
    files: {
      "app/pages/search.vue": `<script setup lang="ts">
useFetch('/api/rules/query', { method: 'POST', body })
useFetch('/api/search/delete', { method: 'POST', body })
useFetch('/api/rules/query/update', { method: 'POST', body })
useFetch('/api/jobs/trigger', { method: 'POST', body })
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.severity)).toEqual(["error", "error", "error"]);
});

test("POST async data supports readonly path and write-like segment options", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [postFetchRequiresReadonlyMarker],
    config: {
      rules: {
        "nuxt/post-fetch-requires-readonly-marker": [
          "error",
          {
            readonlyPaths: ["/api/cube/**"],
            writeLikePathSegments: ["mutate"],
          },
        ],
      },
    },
    files: {
      "app/pages/search.vue": `<script setup lang="ts">
useFetch('/api/cube/query', { method: 'POST', body })
useFetch('/api/foo/mutate', { method: 'POST', body })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.severity).toBe("error");
});

test("POST async data readonly paths match dynamic request patterns", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [postFetchRequiresReadonlyMarker],
    config: {
      rules: {
        "nuxt/post-fetch-requires-readonly-marker": [
          "error",
          {
            readonlyPaths: ["/api/npi/launches/**", "/api/product/chart/**"],
          },
        ],
      },
    },
    files: {
      "app/pages/search.vue": `<script setup lang="ts">
const launchId = 'launch-1'
const drilldownDate = ref('2026-01-01')
useFetch(\`/api/npi/launches/\${launchId}/chartdata\`, { method: 'POST', body })
useLazyFetch(() => \`/api/product/chart/forecast/drilldown/\${drilldownDate.value}\`, { method: 'POST', body })
useFetch(\`/api/jobs/\${launchId}/trigger\`, { method: 'POST', body })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.severity).toBe("error");
  expect(result.diagnostics[0]?.message).toContain("/api/jobs/*/trigger");
});

test("manual action useFetch warns for manual refresh and errors for mutating methods", async () => {
  const result = await runRuleFixture({
    rule: noManualActionUseFetch,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
const { refresh } = useAsyncData('settings', () => $fetch('/api/settings'), { immediate: false })
const { execute } = useLazyFetch('/api/settings', { method: 'DELETE', immediate: false })
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.severity)).toEqual(["warn", "error"]);
});

test("manual action useFetch keeps read-like POST immediate:false as warning", async () => {
  const result = await runRuleFixture({
    rule: noManualActionUseFetch,
    framework: "nuxt",
    files: {
      "app/pages/search.vue": `<script setup lang="ts">
const { execute } = useLazyFetch('/api/search', { method: 'POST', immediate: false })
</script>`,
    },
  });

  expect(result.diagnostics[0]?.severity).toBe("warn");
});

test("preview mode rule accepts explicit callbacks", async () => {
  const result = await runRuleFixture({
    rule: previewModeGlobalRefresh,
    framework: "nuxt",
    files: {
      "app/plugins/preview.ts": `usePreviewMode({
  shouldEnable: () => import.meta.dev,
  onEnable: () => {},
  onDisable: () => {},
})`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("preview mode rule can require review even with explicit callbacks", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [previewModeGlobalRefresh],
    config: {
      rules: {
        "nuxt/preview-mode-global-refresh": [
          "warn",
          { allowPreviewBroadEnablementWithExplicitCallbacks: false },
        ],
      },
    },
    files: {
      "app/plugins/preview.ts": `usePreviewMode({
  shouldEnable: () => import.meta.dev,
  onEnable: () => {},
  onDisable: () => {},
})`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nuxt/preview-mode-global-refresh");
});

test("global refresh rule accepts keyed refreshes and explicit global intent", async () => {
  const result = await runRuleFixture({
    rule: noGlobalRefreshWithoutJustification,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
refreshNuxtData('settings')
refreshNuxtData(['a', 'b'])
// nuxt-doctor: global-refresh-intentional preview mode refreshes all read data
refreshNuxtData()
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("global refresh intent marker only suppresses the adjacent call", async () => {
  const result = await runRuleFixture({
    rule: noGlobalRefreshWithoutJustification,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
// nuxt-doctor: global-refresh-intentional preview mode refreshes all read data
refreshNuxtData()
refreshNuxtData()
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
});

test("global refresh rule accepts nearby natural-language justification", async () => {
  const result = await runRuleFixture({
    rule: noGlobalRefreshWithoutJustification,
    framework: "nuxt",
    files: {
      "app/plugins/fix.client.ts": `export default defineNuxtPlugin((nuxtApp) => {
  // When an empty payload skips refetching during hydration, refresh all async data
  // so package analysis and README data are loaded after suspense resolves.
  nuxtApp.hooks.hookOnce('app:suspense:resolve', () => {
    refreshNuxtData()
  })
})`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("refreshable async data key rule accepts explicit keys", async () => {
  const result = await runRuleFixture({
    rule: asyncDataExplicitKeyForRefreshable,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
const { refresh: refreshA } = useAsyncData('settings', () => $fetch('/api/settings'))
const { refresh: refreshB } = useFetch('/api/settings', { key: 'settings' })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("refreshable async data key rule reports only locally refreshable unkeyed entries", async () => {
  const result = await runRuleFixture({
    rule: asyncDataExplicitKeyForRefreshable,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
refreshNuxtData('settings')
useFetch('/api/passive')
const { refresh } = useFetch('/api/settings')
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
});

test("refreshable async data key rule warns for a single unkeyed entry with keyed refresh", async () => {
  const result = await runRuleFixture({
    rule: asyncDataExplicitKeyForRefreshable,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
useFetch('/api/settings')
refreshNuxtData('settings')
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
});

test("async data handler purity reports replayable side effects conservatively", async () => {
  const result = await runRuleFixture({
    rule: asyncDataHandlerPure,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
useAsyncData('settings', async () => {
  analytics.track('loaded')
  return $fetch('/api/settings')
})
</script>`,
    },
  });

  expect(result.diagnostics[0]?.severity).toBe("warn");
});

test("async data handler purity respects readonly POST markers", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [asyncDataHandlerPure],
    config: {
      rules: {
        "nuxt/async-data-handler-pure": ["warn", { readonlyPaths: ["/api/cube/**"] }],
      },
    },
    files: {
      "app/pages/search.vue": `<script setup lang="ts">
useAsyncData('marked', () => $fetch('/api/search', {
  method: 'POST',
  body,
}), {
  meta: { readonly: true },
})
useAsyncData('configured', () => $fetch('/api/cube/query', {
  method: 'POST',
  body,
}))
useAsyncData('write', () => $fetch('/api/settings', {
  method: 'POST',
  body,
}))
useAsyncData('delete', () => $fetch('/api/settings', {
  method: 'DELETE',
}))
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.severity)).toEqual(["warn"]);

  const deleteResult = await runRuleFixture({
    rule: asyncDataHandlerPure,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
useAsyncData('delete', () => $fetch('/api/settings', {
  method: 'DELETE',
}))
</script>`,
    },
  });
  expect(deleteResult.diagnostics.map((item) => item.severity)).toEqual(["error"]);
});

test("async data handler purity readonly paths match dynamic fetch patterns", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [asyncDataHandlerPure],
    config: {
      rules: {
        "nuxt/async-data-handler-pure": ["error", { readonlyPaths: ["/api/npi/launches/**"] }],
      },
    },
    files: {
      "app/pages/search.vue": `<script setup lang="ts">
const launchId = 'launch-1'
useAsyncData('notice', () => $fetch(\`/api/npi/launches/\${launchId}/chartdata\`, {
  method: 'POST',
}))
useAsyncData('write', () => $fetch(\`/api/jobs/\${launchId}/trigger\`, {
  method: 'POST',
}))
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.severity)).toEqual(["error"]);
});

test("async data handler purity reports write-like POST paths inside query-like endpoints", async () => {
  const result = await runRuleFixture({
    rule: asyncDataHandlerPure,
    framework: "nuxt",
    files: {
      "app/pages/search.vue": `<script setup lang="ts">
useAsyncData('query', () => $fetch('/api/rules/query', {
  method: 'POST',
}))
useAsyncData('write', () => $fetch('/api/search/delete', {
  method: 'POST',
}))
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.severity)).toEqual(["error"]);
});

test("async data handler purity narrows store assignment evidence to local Pinia stores", async () => {
  const result = await runRuleFixture({
    rule: asyncDataHandlerPure,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
const generic = { seen: false }
const userStore = useUserStore()
useAsyncData('generic', () => {
  generic.seen = true
  return $fetch('/api/generic')
})
useAsyncData('store', () => {
  userStore.seen = true
  return $fetch('/api/store')
})
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.severity).toBe("warn");
});

test("async data handler purity ignores nested callbacks unless synchronously invoked", async () => {
  const result = await runRuleFixture({
    rule: asyncDataHandlerPure,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
useAsyncData('ignored', () => {
  onMounted(() => toast.add({ title: 'Mounted' }))
  return $fetch('/api/ignored')
})
useAsyncData('invoked', () => {
  const mark = () => toast.add({ title: 'Loaded' })
  mark()
  return $fetch('/api/invoked')
})
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
});

test("async data handler purity supports opt-in side-effect callees", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [asyncDataHandlerPure],
    config: {
      rules: {
        "nuxt/async-data-handler-pure": ["warn", { sideEffectCallees: ["metrics.count"] }],
      },
    },
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
useAsyncData('metrics', () => {
  metrics.count('loaded')
  return $fetch('/api/settings')
})
</script>`,
    },
  });

  expect(result.diagnostics[0]?.severity).toBe("warn");
});

test("useFetch callback side effects warn for reads and error for writes", async () => {
  const result = await runRuleFixture({
    rule: noMutationToastInUseFetchCallback,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<script setup lang="ts">
useFetch('/api/settings', { onResponse() { toast.add({ title: 'Loaded' }) } })
useFetch('/api/settings', { method: 'PUT', onResponse() { toast.add({ title: 'Saved' }) } })
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.severity)).toEqual(["warn", "error"]);
});

test("app directory placement is only reported for Nuxt 4 projects", async () => {
  const result = await runRuleFixture({
    rule: preferAppDirectoryPlacement,
    framework: "nuxt",
    dependencies: { nuxt: "3.16.2" },
    files: { "pages/index.vue": `<template><div /></template>` },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("app directory placement ignores shadcn component registry roots", async () => {
  const result = await runRuleFixture({
    rule: preferAppDirectoryPlacement,
    framework: "nuxt",
    dependencies: { nuxt: "^4.4.5", "shadcn-nuxt": "^2.4.0" },
    files: {
      "components/ui/button/index.ts": `export { default as Button } from './Button.vue'`,
      "components/AppHeader.vue": `<template><header /></template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.file).toContain("components/AppHeader.vue");
});

test("prefer NuxtLink reports relative internal anchors", async () => {
  const result = await runRuleFixture({
    rule: preferNuxtLink,
    framework: "nuxt",
    files: {
      "app/pages/settings.vue": `<template><a href="./settings">Settings</a></template>`,
      "app/pages/profile.vue": `<template><a href="../profile">Profile</a></template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "nuxt/routing/prefer-nuxtlink",
    "nuxt/routing/prefer-nuxtlink",
  ]);
});

test("prefer NuxtLink ignores non-app-navigation anchors", async () => {
  const result = await runRuleFixture({
    rule: preferNuxtLink,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>
  <a href="https://example.com">External</a>
  <a href="//example.com">Protocol relative</a>
  <a href="mailto:hello@example.com">Email</a>
  <a href="tel:+15555555555">Call</a>
  <a href="sms:+15555555555">Text</a>
  <a href="javascript:void 0">Action</a>
  <a href="data:text/plain,hello">Data</a>
  <a href="blob:https://example.com/file">Blob</a>
  <a href="#section">Jump</a>
  <a href="/file.pdf" download>Download</a>
  <a href="/about" target="_blank">New tab</a>
  <NuxtLink to="/about">About</NuxtLink>
</template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("prefer NuxtLink provides a safe fix for static internal anchors", async () => {
  const result = await runRuleFixture({
    rule: preferNuxtLink,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template><a class="nav" href="/about">About</a></template>`,
    },
  });

  expect(result.diagnostics[0]?.fix).toEqual({
    kind: "safe",
    edits: [
      {
        range: expect.any(Object),
        text: `<NuxtLink class="nav" to="/about">About</NuxtLink>`,
      },
    ],
  });
});

test("Nitro pack is exported and consumed by Nuxt rule packs", () => {
  const packs = nuxtRulePacks();
  expect(nitroRulePack.rules.map((rule) => rule.meta.id)).toEqual(
    expect.arrayContaining([
      "nitro/migration/no-v2-imports",
      "nitro/runtime/require-event-runtime-config-in-server",
      "nitro/request/prefer-validated-body",
      "nitro/request/prefer-validated-query",
      "nitro/request/prefer-validated-router-params",
      "nitro/request/prefer-assert-method",
      "nitro/request/prefer-route-method-suffix",
      "nitro/request/prefer-get-request-ip",
    ]),
  );
  expect(packs.map((pack) => pack.name)).toContain("vite-doctor/nitro");
  expect(
    packs.find((pack) => pack.name === "vite-doctor/nuxt")?.rules.map((rule) => rule.meta.id),
  ).not.toContain("nitro/migration/no-v2-imports");
});

test("Nitro request rules prefer validated H3 utilities", async () => {
  const body = await runRuleFixture({
    rule: preferValidatedBody,
    framework: "nuxt",
    files: {
      "server/api/user.post.ts": `export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  return userBodySchema.parse(body)
})`,
    },
  });
  const query = await runRuleFixture({
    rule: preferValidatedQuery,
    framework: "nuxt",
    files: {
      "server/api/search.get.ts": `export default defineEventHandler((event) => {
  const query = getQuery(event)
  return searchSchema.safeParse(query)
})`,
    },
  });
  const params = await runRuleFixture({
    rule: preferValidatedRouterParams,
    framework: "nuxt",
    files: {
      "server/api/users/[id].get.ts": `export default defineEventHandler((event) => {
  const params = getRouterParams(event)
  return validateParams(params)
})`,
    },
  });

  expect(body.diagnostics[0]?.ruleId).toBe("nitro/request/prefer-validated-body");
  expect(query.diagnostics[0]?.ruleId).toBe("nitro/request/prefer-validated-query");
  expect(params.diagnostics[0]?.ruleId).toBe("nitro/request/prefer-validated-router-params");
});

test("Nitro validation rules ignore validated utilities and unrelated validation", async () => {
  const alreadyValidated = await runRuleFixture({
    rule: preferValidatedBody,
    framework: "nuxt",
    files: {
      "server/api/user.post.ts": `export default defineEventHandler((event) => {
  return readValidatedBody(event, userBodySchema.parse)
})`,
    },
  });
  const rawOnly = await runRuleFixture({
    rule: preferValidatedQuery,
    framework: "nuxt",
    files: {
      "server/api/search.get.ts": `export default defineEventHandler((event) => {
  const query = getQuery(event)
  return query.q
})`,
    },
  });
  const unrelated = await runRuleFixture({
    rule: preferValidatedRouterParams,
    framework: "nuxt",
    files: {
      "server/api/users/[id].get.ts": `export default defineEventHandler(async (event) => {
  const params = getRouterParams(event)
  const body = await readBody(event)
  return paramsSchema.parse(body)
})`,
    },
  });

  expect(alreadyValidated.diagnostics).toHaveLength(0);
  expect(rawOnly.diagnostics).toHaveLength(0);
  expect(unrelated.diagnostics).toHaveLength(0);
});

test("Nitro request rules prefer route method suffixes for file-routed method gates", async () => {
  const result = await runRuleFixture({
    rule: preferRouteMethodSuffix,
    framework: "nuxt",
    files: {
      "server/routes/tasks/[...asset].ts": `export default defineEventHandler((event) => {
  const request = event.req
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 })
  }
  return {}
})`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nitro/request/prefer-route-method-suffix");
  expect(result.diagnostics[0]?.suggestion).toContain("server/routes/tasks/[...asset].get.ts");
  expect(result.diagnostics[0]?.suggestion).toContain("server/routes/tasks/[...asset].head.ts");
});

test("Nitro route method suffix rule reports redundant guards in suffixed route files", async () => {
  const result = await runRuleFixture({
    rule: preferRouteMethodSuffix,
    framework: "nuxt",
    files: {
      "server/api/user.post.ts": `export default defineEventHandler((event) => {
  if (event.req.method !== 'POST') throw createError({ statusCode: 405 })
  return {}
})`,
    },
  });

  expect(result.diagnostics[0]?.suggestion).toContain(".post.ts already constrains this route");
});

test("Nitro route method suffix rule does not treat mismatched suffixed route guards as redundant", async () => {
  const result = await runRuleFixture({
    rule: preferRouteMethodSuffix,
    framework: "nuxt",
    files: {
      "server/api/user.get.ts": `export default defineEventHandler((event) => {
  if (event.req.method !== 'POST') throw createError({ statusCode: 405 })
  return {}
})`,
    },
  });

  expect(result.diagnostics[0]?.suggestion).toContain("server/api/user.post.ts");
  expect(result.diagnostics[0]?.suggestion).not.toContain("already constrains this route");
});

test("Nitro route method suffix rule does not suggest moving whole handlers for positive dispatch", async () => {
  const result = await runRuleFixture({
    rule: preferRouteMethodSuffix,
    framework: "nuxt",
    files: {
      "server/api/users.ts": `export default defineEventHandler((event) => {
  if (event.req.method === 'POST') return createUser(event)
  return listUsers(event)
})`,
    },
  });

  expect(result.diagnostics[0]?.suggestion).toContain("POST-specific branch");
  expect(result.diagnostics[0]?.suggestion).not.toContain("Move this handler");
});

test("Nitro route method suffix rule reports non-if method gates in file-routed handlers", async () => {
  const result = await runRuleFixture({
    rule: preferRouteMethodSuffix,
    framework: "nuxt",
    files: {
      "server/api/user.ts": `export default defineEventHandler((event) => {
  return event.req.method !== 'POST' ? Response.json({}, { status: 405 }) : updateUser(event)
})`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nitro/request/prefer-route-method-suffix");
  expect(result.diagnostics[0]?.suggestion).toContain("POST-specific branch");
});

test("Nitro route method suffix rule ignores request aliases from unrelated nested scopes", async () => {
  const result = await runRuleFixture({
    rule: preferRouteMethodSuffix,
    framework: "nuxt",
    files: {
      "server/api/user.ts": `export default defineEventHandler((event) => {
  function readNestedRequest() {
    const request = event.req
    return request.method
  }
  const request = { method: 'POST' }
  if (request.method !== 'POST') return readNestedRequest()
  return {}
})`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("Nitro request rules prefer assertMethod for non-file-routed single-method checks", async () => {
  const result = await runRuleFixture({
    rule: preferAssertMethod,
    framework: "nuxt",
    files: {
      "server/middleware/api-auth.ts": `export default defineEventHandler((event) => {
  if (getMethod(event) !== 'POST') throw createError({ statusCode: 405 })
  return {}
})`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nitro/request/prefer-assert-method");
});

test("Nitro assertMethod rule ignores file-routed method gates", async () => {
  const result = await runRuleFixture({
    rule: preferAssertMethod,
    framework: "nuxt",
    files: {
      "server/api/user.ts": `export default defineEventHandler((event) => {
  if (getMethod(event) !== 'POST') throw createError({ statusCode: 405 })
  return {}
})`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("Nitro request IP rule reports only request-sensitive raw header reads", async () => {
  const sensitive = await runRuleFixture({
    rule: preferGetRequestIp,
    framework: "nuxt",
    files: {
      "server/api/rate-limit.ts": `export default defineEventHandler((event) => {
  const ip = getHeader(event, 'x-forwarded-for')
  return rateLimit(ip)
})`,
    },
  });
  const passive = await runRuleFixture({
    rule: preferGetRequestIp,
    framework: "nuxt",
    files: {
      "server/api/debug.ts": `export default defineEventHandler((event) => {
  const forwarded = getHeader(event, 'x-forwarded-for')
  return { forwarded }
})`,
    },
  });

  expect(sensitive.diagnostics[0]?.ruleId).toBe("nitro/request/prefer-get-request-ip");
  expect(passive.diagnostics).toHaveLength(0);
});

test("non-SEO head metadata is ignored by SEO composable preference", async () => {
  const result = await runRuleFixture({
    rule: preferSeoComposables,
    framework: "nuxt",
    files: {
      "app/app.vue": `<script setup lang="ts">
useHead({
  meta: [
    { charset: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { name: 'theme-color', content: 'white' }
  ],
  link: [{ rel: 'icon', href: '/favicon.ico' }],
  htmlAttrs: { lang: 'en' }
})
useSeoMeta({ title: 'Home', description: 'Dashboard' })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("static head attributes are ignored by useHeadSafe preference", async () => {
  const result = await runRuleFixture({
    rule: preferUseHeadSafeForUntrustedValues,
    framework: "nuxt",
    files: {
      "app/error.vue": `<script setup lang="ts">
useHead({ htmlAttrs: { lang: 'en' } })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("client-only string props are ignored by template conditional rule", async () => {
  const result = await runRuleFixture({
    rule: noClientConditionalInTemplate,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>
<section>
  <CodeBlock :code="\`if (import.meta.client) console.log('client')\`" />
  <div v-if="show">Visible</div>
</section>
</template>
<script setup lang="ts">
const show = true
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("top-level script setup composables after awaited data are compiler-preserved", async () => {
  const result = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
const { data } = await useAsyncData('home', () => $fetch('/api/public'))
useSeoMeta({ title: data.value?.title })
useHead({ meta: [{ name: 'description', content: 'Home' }] })
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("composables after await in custom async functions still report", async () => {
  const result = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/composables/useThing.ts": `export async function useThing() {
  await load()
  return useRuntimeConfig()
}`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nuxt/context/no-composable-after-await");
});

test("composable aliases after await still report", async () => {
  const result = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/composables/useThing.ts": `export async function useThing() {
  const loadFetch = useFetch
  await load()
  return loadFetch('/api/thing')
}`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nuxt/context/no-composable-after-await");
});

test("nested async helpers do not count as prior awaits", async () => {
  const result = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/composables/useThing.ts": `export function useThing() {
  async function loadLater() {
    await load()
  }
  const data = useAsyncData('thing', () => $fetch('/api/thing'))
  return { data, loadLater }
}`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("route middleware may return navigateTo after awaited session loading", async () => {
  const result = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(async () => {
  const { loggedIn, fetchSession } = useUserSession()
  if (!loggedIn.value) {
    await fetchSession()
    return navigateTo('/')
  }
})`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("navigateTo after await in client-callable handlers is ignored", async () => {
  const result = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/components/SearchBox.vue": `<template><button @click="submit">Search</button></template>
<script setup lang="ts">
async function submit() {
  await saveSearch()
  navigateTo('/search')
}
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("navigateTo after await in object onClick handlers is ignored", async () => {
  const result = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/components/Menu.vue": `<script setup lang="ts">
async function logout() {
  await clear()
  navigateTo('/login')
}
const items = [{ label: 'Logout', onClick: logout }]
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("navigateTo after await in component prop handlers is ignored", async () => {
  const result = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/components/EditForm.vue": `<template>
<ActionForm :action="save" :on-delete="remove" />
</template>
<script setup lang="ts">
async function save() {
  await persist()
  await navigateTo('/items')
}
async function remove() {
  await destroy()
  navigateTo('/items')
}
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("time utilities that do not reach SSR output are ignored", async () => {
  const result = await runRuleFixture({
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    framework: "nuxt",
    files: {
      "app/components/Chart.vue": `<template><ChartCanvas :points="points" /></template>
<script setup lang="ts">
const points = computed(() => [{ x: Date.UTC(2024, 1, 1), y: new Date(build.time).getTime() }])
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("direct SSR time output still reports", async () => {
  const result = await runRuleFixture({
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>{{ now }}</template><script setup lang="ts">const now = Date.now()</script>`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe(
    "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
  );
  expect(result.diagnostics[0]?.sources).toBeUndefined();
  expect(result.diagnostics[0]?.docs).toBe("https://vite-doctor.onmax.me/diagnostics/NUXT0032");
  expect(createTextReport(result)).not.toContain(
    "sources: https://nuxt.com/docs/4.x/guide/best-practices/hydration#dynamic-content-based-on-time",
  );
});

test("useState initializer time values are serialized before hydration", async () => {
  const result = await runRuleFixture({
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    framework: "nuxt",
    files: {
      "app/composables/useDateRange.ts": `export function useDateRange() {
  return useState('date-range', () => {
    const end = new Date()
    return { end: end.toISOString() }
  })
}`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("browser globals after server return guard are ignored", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/composables/useToc.ts": `export function useToc() {
  if (import.meta.server) return
  return document.querySelectorAll('h2')
}`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("browser globals after typeof undefined return guard are ignored", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/composables/useHost.ts": `export function useHost() {
  if (typeof window === 'undefined') return ''
  return window.location.hostname
}`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("browser globals in typeof undefined short-circuit guards are ignored", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/components/Canvas.vue": `<script setup lang="ts">
const circlePath = computed(() => {
  if (typeof window === 'undefined' || !window.Path2D)
    return null
  return new Path2D()
})
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("VueUse wrappers may receive browser global targets", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
useEventListener(window, 'resize', () => {})
useIntersectionObserver(document.body, () => {})
const locked = useScrollLock(document)
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("browser globals in template-bound command functions are client-callable", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/components/DownloadButton.vue": `<template><button @click="download">Download</button></template>
<script setup lang="ts">
function download() {
  document.createElement('a').click()
}
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("client-callable function chains suppress browser globals", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/composables/useKeyboardList.ts": `<script setup lang="ts">
function isSearchFocused() {
  return document.activeElement?.tagName === 'INPUT'
}
function focusFirst() {
  document.querySelector('button')?.focus()
}
function onKeydown(event: KeyboardEvent) {
  if (isSearchFocused()) return
  if (event.key === 'Enter') focusFirst()
}
useEventListener('keydown', onKeydown)
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("functions called from client lifecycle callbacks suppress browser globals", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/components/AnimatedPanel.vue": `<script setup lang="ts">
function startTimeout() {
  window.setTimeout(() => {}, 100)
}

function cleanup() {
  window.removeEventListener('resize', cleanup)
}

onMounted(() => {
  startTimeout()
})

onBeforeUnmount(cleanup)
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("returned command functions suppress browser globals", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/composables/useDownload.ts": `export function useDownload() {
  function download() {
    const a = document.createElement('a')
    a.click()
  }
  return { download }
}`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("unknown browser globals downgrade to warnings without build evidence", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/utils/browser.ts": `export function getWidth() { return window.innerWidth }`,
    },
  });

  expect(result.diagnostics[0]?.severity).toBe("warn");
});

test("server browser API rule ignores browser-global property names", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInServer,
    framework: "nuxt",
    files: {
      "server/api/team.ts": `export default defineEventHandler(() => ({
  location: member.location,
  navigator: profile.navigator
}))`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("deterministic async data keys are accepted", async () => {
  const result = await runRuleFixture({
    rule: requireStableAsyncDataKey,
    framework: "nuxt",
    files: {
      "app/pages/pkg.vue": `<script setup lang="ts">
const route = useRoute()
await useAsyncData(kebabCase(route.path), () => $fetch('/api/pkg'))
await useAsyncData(\`pkg:\${route.params.name}\`, () => $fetch('/api/pkg'))
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("obviously unstable async data keys still report", async () => {
  const result = await runRuleFixture({
    rule: requireStableAsyncDataKey,
    framework: "nuxt",
    files: {
      "app/pages/pkg.vue": `<script setup lang="ts">await useAsyncData(Date.now(), () => $fetch('/api/pkg'))</script>`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nuxt/fetch/require-stable-asyncdata-key");
});

test("page-local missing async data key is suppressed while reusable composable still reports", async () => {
  const page = await runRuleFixture({
    rule: requireStableAsyncDataKey,
    framework: "nuxt",
    files: {
      "app/pages/package.vue": `<script setup lang="ts">await useAsyncData(() => $fetch('/api/package'))</script>`,
    },
  });
  const composable = await runRuleFixture({
    rule: requireStableAsyncDataKey,
    framework: "nuxt",
    files: {
      "app/composables/usePackage.ts": `export function usePackage() { return useAsyncData(() => $fetch('/api/package')) }`,
    },
  });

  expect(page.diagnostics).toHaveLength(0);
  expect(composable.diagnostics[0]?.ruleId).toBe("nuxt/fetch/require-stable-asyncdata-key");
});

test("client-only useState non-serializable values are ignored while SSR state reports", async () => {
  const client = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/plugins/visited.client.ts": `export default defineNuxtPlugin(() => useState('visited', () => new Set()))`,
    },
  });
  const universal = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/composables/useVisited.ts": `export function useVisited() { return useState('visited', () => new Set()) }`,
    },
  });

  expect(client.diagnostics).toHaveLength(0);
  expect(universal.diagnostics[0]?.ruleId).toBe("nuxt/state/no-nonserializable-usestate");
});

test("useState allows factory-local Date values converted to strings", async () => {
  const result = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/composables/useDateRange.ts": `export function useDateRange() {
  return useState('date-range', () => {
    const end = new Date()
    return {
      start: subDays(end, 30).toISOString(),
      end: end.toISOString()
    }
  })
}`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("useState still reports returned Date instances", async () => {
  const result = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/composables/useDateRange.ts": `export function useDateRange() {
  return useState('date-range', () => ({ end: new Date() }))
}`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nuxt/state/no-nonserializable-usestate");
  expect(result.diagnostics[0]?.sources).toBeUndefined();
  expect(createTextReport(result)).not.toContain("sources: https://nuxt.com/docs");
});

test("Vue lifecycle evidence skips Nuxt content, server, generated, and client-only files", async () => {
  await withFixture(
    {
      "content/demo.md": `setInterval(() => {}, 1000)`,
      "server/api/events.ts": `export default defineEventHandler(() => setInterval(() => {}, 1000))`,
      "shared/types/lexicons/generated.ts": `// @generated\nnew IntersectionObserver(() => {})`,
      "app/plugins/view.client.ts": `setInterval(() => {}, 1000)`,
      "app/components/Leaky.vue": `<script setup>setInterval(() => {}, 1000)</script>`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [defineDoctorExtension({ name: "vue", rulePacks: [vueRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "vue/lifecycle/require-cleanup",
      ]);
      expect(result.diagnostics[0]?.file).toContain("app/components/Leaky.vue");
    },
  );
});

test("Nuxt UI button rule reports native buttons", async () => {
  const result = await runRuleFixture({
    rule: preferUButton,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template><button type="button" @click="copy()">Copy</button></template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.ruleId).toBe("nuxt-ui/prefer-u-button");
  expect(result.diagnostics[0]?.suggestion).toContain("<UButton>");
});

test("Nuxt UI button rule ignores UButton and explicit doctor ignores", async () => {
  const result = await runRuleFixture({
    rule: preferUButton,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>
<UButton @click="copy()">Copy</UButton>
<button data-doctor-ignore type="button">Native</button>
</template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("Nuxt UI form controls rule reports clear native form control replacements", async () => {
  const result = await runRuleFixture({
    rule: preferUFormControls,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>
<input type="email" v-model="email">
<textarea v-model="body" />
<select v-model="value"><option value="a">A</option></select>
</template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "nuxt-ui/prefer-u-form-controls",
    "nuxt-ui/prefer-u-form-controls",
    "nuxt-ui/prefer-u-form-controls",
  ]);
  expect(result.diagnostics.map((item) => item.suggestion)).toEqual([
    expect.stringContaining("<UInput>"),
    expect.stringContaining("<UTextarea>"),
    expect.stringContaining("<USelect>"),
  ]);
});

test("Nuxt UI form controls rule ignores ambiguous native inputs and layout elements", async () => {
  const result = await runRuleFixture({
    rule: preferUFormControls,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>
<div>
  <form>
    <label>Email</label>
    <input type="checkbox">
    <input type="file">
    <input type="hidden">
    <input :type="dynamicType">
  </form>
</div>
</template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

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

test("top-level browser globals report while unrendered time setup values are ignored", async () => {
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
  expect(time.diagnostics).toHaveLength(0);
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
  expect(time.diagnostics).toHaveLength(0);
});

test("Nuxt runtime rules skip content, config, generated, client-only, and external package noise", async () => {
  const markdownMiddleware = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "content/blog/release.md":
        "```ts [middleware/auth.ts]\nexport default defineNuxtRouteMiddleware(() => navigateTo('/login'))\n```",
      "server/api/private.get.ts": `export default defineEventHandler(() => ({ ok: true }))`,
    },
  });
  const env = await runRuleFixture({
    rule: noPlainEnvInAppCode,
    framework: "nuxt",
    files: {
      "content.config.ts": `export default { source: process.env.CONTENT_SOURCE }`,
      "config/env.ts": `export const isPr = Boolean(process.env.PULL_REQUEST)`,
      "cli/src/cli.ts": `if (process.env.DEBUG) process.exit(0)`,
      "app/pages/index.vue": `<script setup lang="ts">const key = process.env.API_KEY</script>`,
    },
  });
  const generatedShared = await runRuleFixture({
    rule: noNestedSharedAutoimportAssumption,
    framework: "nuxt",
    files: {
      "shared/types/lexicons/app/bsky/actor.ts": `// @generated\nexport interface Actor { did: string }`,
      "shared/utils/nested/math.ts": `export const one = 1`,
    },
  });
  const clientAwait = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/components/CommandPalette.client.vue": `<script setup lang="ts">
async function handleSelect(to: string) {
  await close()
  await navigateTo(to)
}
</script>`,
      "app/pages/index.vue": `<script setup lang="ts">await foo(); useRuntimeConfig()</script>`,
    },
  });

  expect(markdownMiddleware.diagnostics).toHaveLength(0);
  expect(env.diagnostics.map((item) => item.file)).toHaveLength(1);
  expect(env.diagnostics[0]?.file).toContain("app/pages/index.vue");
  expect(generatedShared.diagnostics.map((item) => item.file)).toHaveLength(1);
  expect(generatedShared.diagnostics[0]?.file).toContain("shared/utils/nested/math.ts");
  expect(clientAwait.diagnostics).toHaveLength(0);
});

test("VueUse preference rules suggest composables for raw browser APIs", async () => {
  const timers = await runRuleFixture({
    rule: preferUseTimers,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
setTimeout(() => {}, 100)
window.setInterval(() => {}, 1000)
requestAnimationFrame(() => {})
</script>`,
    },
  });
  const observers = await runRuleFixture({
    rule: preferUseObservers,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
new IntersectionObserver(() => {})
new ResizeObserver(() => {})
new MutationObserver(() => {})
</script>`,
    },
  });
  const events = await runRuleFixture({
    rule: preferUseEventListener,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
window.addEventListener('resize', () => {})
document.addEventListener('click', () => {})
addEventListener('online', () => {})
</script>`,
    },
  });
  const storage = await runRuleFixture({
    rule: preferUseStorage,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
localStorage.getItem('theme')
sessionStorage.setItem('tab', 'one')
</script>`,
    },
  });
  const scroll = await runRuleFixture({
    rule: preferUseScrollAndElement,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
const y = window.scrollY
window.scrollTo(0, 100)
target.value?.getBoundingClientRect()
</script>`,
    },
  });

  expect(timers.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use VueUse useTimeoutFn() for lifecycle-aware timing.",
    "Use VueUse useIntervalFn() for lifecycle-aware timing.",
    "Use VueUse useRafFn() for lifecycle-aware timing.",
  ]);
  expect(observers.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use VueUse useIntersectionObserver() for reactive observer cleanup.",
    "Use VueUse useResizeObserver() for reactive observer cleanup.",
    "Use VueUse useMutationObserver() for reactive observer cleanup.",
  ]);
  expect(events.diagnostics).toHaveLength(3);
  expect(storage.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use VueUse useStorage() for reactive client storage state.",
    "Use VueUse useSessionStorage() for reactive client storage state.",
  ]);
  expect(scroll.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use VueUse useScroll() for reactive browser state.",
    "Use VueUse useScroll() for reactive browser state.",
    "Use VueUse useElementBounding() for reactive browser state.",
  ]);
});

test("VueUse preference rules skip existing composables and non-runtime files", async () => {
  const timers = await runRuleFixture({
    rule: preferUseTimers,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
useTimeoutFn(() => {
  setTimeout(() => {}, 100)
}, 100)
</script>`,
      "server/api/timer.ts": `export default defineEventHandler(() => setTimeout(() => {}, 100))`,
      "shared/types/generated.ts": `// @generated\nsetInterval(() => {}, 100)`,
    },
  });
  const observers = await runRuleFixture({
    rule: preferUseObservers,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
useIntersectionObserver(target, () => {
  new IntersectionObserver(() => {})
})
</script>`,
      "app/generated/observer.ts": `new ResizeObserver(() => {})`,
    },
  });
  const events = await runRuleFixture({
    rule: preferUseEventListener,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
useEventListener(window, 'resize', () => {
  window.addEventListener('scroll', () => {})
})
</script>`,
      "docs/app/pages/index.vue": `<script setup lang="ts">window.addEventListener('resize', () => {})</script>`,
    },
  });
  const storage = await runRuleFixture({
    rule: preferUseStorage,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
const hasStorage = typeof localStorage !== 'undefined'
useStorage('theme', localStorage.getItem('theme'))
</script>`,
    },
  });

  expect(timers.diagnostics).toHaveLength(0);
  expect(observers.diagnostics).toHaveLength(0);
  expect(events.diagnostics).toHaveLength(0);
  expect(storage.diagnostics).toHaveLength(0);
});

test("VueUse timer preference ignores non-timer prototype methods", async () => {
  const result = await runRuleFixture({
    rule: preferUseTimers,
    framework: "nuxt",
    files: {
      "app/utils/colors.ts": `export function toHex(value: number) {
  return value.toString(16)
}

export function serialize(value: unknown) {
  return Object.prototype.toString.call(value)
}
`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("route middleware security rule reports only auth-like middleware without server guards", async () => {
  const redirects = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/docs-version.global.ts": `export default defineNuxtRouteMiddleware((to) => {
  if (!to.path.startsWith('/docs/')) return
  return navigateTo('/docs/4.x')
})`,
      "app/middleware/guest.ts": `export default defineNuxtRouteMiddleware(() => {
  const { loggedIn } = useUserSession()
  if (loggedIn.value) return navigateTo('/admin')
})`,
      "server/api/feedback.get.ts": `export default defineEventHandler(() => [])`,
    },
  });
  const guarded = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => {
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) return navigateTo('/admin/login')
})`,
      "server/api/admin.get.ts": `export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  if (!user?.login || !(await isAuthorizedAdmin(user.login))) throw createError({ statusCode: 403 })
  return {}
})`,
    },
  });
  const unguarded = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => {
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) return navigateTo('/admin/login')
})`,
      "server/api/admin.get.ts": `export default defineEventHandler(() => ({}))`,
    },
  });

  expect(redirects.diagnostics).toHaveLength(0);
  expect(guarded.diagnostics).toHaveLength(0);
  expect(unguarded.diagnostics).toHaveLength(1);
  expect(unguarded.diagnostics[0]?.severity).toBe("warn");
});

test("a guard in one API handler does not hide an unguarded sensitive handler", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/api/admin.get.ts": `export default defineEventHandler((event) => requireUserSession(event))`,
      "server/api/account.get.ts": `export default defineEventHandler(() => ({ private: true }))`,
      "server/api/feedback.get.ts": `export default defineEventHandler(() => [])`,
    },
  });

  const diagnostic = result.diagnostics.find(
    (item) => item.ruleId === noRouteMiddlewareApiSecurity.meta.id,
  );
  expect(diagnostic?.related?.map((item) => item.file)).toEqual([
    expect.stringContaining("server/api/account.get.ts"),
  ]);
  expect(diagnostic?.message).not.toContain("feedback.get.ts");
});

test.each([
  "auth/login.post.ts",
  "auth/sign-in.post.ts",
  "auth/signin.post.ts",
  "auth/callback.get.ts",
  "session/create.post.ts",
  "auth/register/index.post.ts",
  "auth/callback/index.get.ts",
  "auth/register.post.ts",
  "auth/forgot-password.post.ts",
  "auth/reset-password.post.ts",
  "auth/verify-email.get.ts",
  "auth/sign-up.post.ts",
])("public authentication endpoint %s does not require a server guard", async (endpoint) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/api/admin.get.ts": `export default defineEventHandler((event) => requireAuth(event))`,
      [`server/api/${endpoint}`]: `export default defineEventHandler(() => ({}))`,
      "server/handlers/entry.ts": `export default defineEventHandler(() => ({}))`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        nuxtVersion: "4",
        vueVersion: "3.5",
        appDir: "app",
        serverHandlers: [
          {
            file: "server/handlers/entry.ts",
            route: `/api/${endpoint.replace(/\.(get|post)?\.?ts$/, "").replace(/\/index$/, "")}`,
            method: endpoint.includes(".get.") ? "get" : "post",
          },
        ],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  "auth/register/index.get.ts",
  "auth/register.get.ts",
  "auth/register.delete.ts",
  "auth/register.ts",
  "auth/callback.post.ts",
  "auth/logout.post.ts",
  "auth/revoke.post.ts",
  "auth/mfa.post.ts",
  "auth/[...all].ts",
  "session.delete.ts",
  "session.get.ts",
  "accounts.get.ts",
  "profiles.get.ts",
  "sessions.get.ts",
])("unguarded protected authentication endpoint %s is reported", async (endpoint) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      [`server/api/${endpoint}`]: `export default defineEventHandler(() => ({}))`,
      "server/handlers/entry.ts": `export default defineEventHandler(() => ({}))`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        nuxtVersion: "4",
        vueVersion: "3.5",
        appDir: "app",
        serverHandlers: [
          {
            file: "server/handlers/entry.ts",
            route: `/api/${endpoint.replace(/\.(?:get|post|delete)?\.?ts$/, "")}`,
            method: endpoint.match(/\.(get|post|delete)\.ts$/)?.[1],
          },
        ],
      }),
    },
  });
  expect(result.diagnostics.map((item) => item.file)).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`server/api/${endpoint}`),
      expect.stringContaining("server/handlers/entry.ts"),
    ]),
  );
});

test("path-scoped server middleware does not hide unrelated sensitive handlers", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/middleware/auth.ts": `export default defineEventHandler((event) => {
        if (event.path.startsWith('/api/admin')) return requireAuth(event)
      })`,
      "server/api/account.get.ts": `export default defineEventHandler(() => ({}))`,
    },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
    expect.stringContaining("server/api/account.get.ts"),
  ]);
});

test.each([
  ["requireAuth", 0],
  ["requireUserSession", 0],
  ["getUserSession", 1],
  ["unknownGuard", 1],
  ["(event) => requireAuth(event)", 0],
  ["async (event) => { const config = useRuntimeConfig(); await requireAuth(event) }", 0],
  ["async (event) => { logRequest(event); await requireAuth(event) }", 0],
  [
    "async (event) => { const config = useRuntimeConfig(); const session = await requireAuth(event) }",
    0,
  ],
  ["(event) => { logRequest(event); return requireAuth(event) }", 0],
  [
    "async (event) => { logRequest(event); if (event.path === '/api/account') return; await requireAuth(event) }",
    1,
  ],
  ["async (event) => { logRequest(event); return; await requireAuth(event) }", 1],
  ["async (event) => { logRequest(event); try { await requireAuth(event) } catch {} }", 1],
  ["async (event) => { await requireUserSession(event) }", 0],
  ["(event) => { return requireAuth(event) }", 0],
  ["async (event) => { return await requireAuth(event) }", 0],
  ["(event) => { if (event.path.startsWith('/api/admin')) return requireAuth(event) }", 1],
  ["async (event) => { if (event.path === '/api/account') return; await requireAuth(event) }", 1],
  ["async (event) => { try { await requireAuth(event) } catch {} }", 1],
  ["async (event) => { const { user } = await requireUserSession(event) }", 0],
  ["async (event) => { const session = await requireAuth(event) }", 0],
  ["(event) => { const session = requireAuth(event) }", 1],
  ["(event) => { requireAuth(event); return { private: true } }", 1],
  ["(event) => { requireAuth(otherEvent); return { private: true } }", 1],
  ["async (event) => { const session = await requireAuth(otherEvent) }", 1],
  ["(event) => { const guard = () => requireAuth(event) }", 1],
  ["(event) => { requireAuth(event) }", 1],
  ["async (event) => { requireAuth(event) }", 1],
  ["(event) => getUserSession(event)", 1],
  ["(event) => isAuthorizedAdmin(event)", 1],
  ["(event) => requireAuth(otherEvent)", 1],
])("server middleware guard coverage for %s", async (handler, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/middleware/auth.ts": `export default defineEventHandler(${handler})`,
      "server/api/account.get.ts": `export default defineEventHandler(() => ({}))`,
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["server/handlers/account.ts", "/api/data", false, false, 1],
  ["server/handlers/data.ts", "/api/account", true, false, 1],
  ["server/handlers/account.ts", "/api/account", true, true, 0],
  ["server/handlers/data.ts", "/api/health", true, false, 0],
])(
  "registered handler coverage for %s at %s",
  async (file, route, conventional, guarded, count) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
        [file]: guarded
          ? `export default defineEventHandler((event) => requireAuth(event))`
          : `export default defineEventHandler(() => ({}))`,
        ...(conventional
          ? { "server/api/health.ts": `export default defineEventHandler(() => ({}))` }
          : {}),
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: new Date().toISOString(),
          nuxtVersion: "4",
          vueVersion: "3.5",
          appDir: "app",
          serverHandlers: [{ file, route }],
        }),
      },
    });
    expect(result.diagnostics).toHaveLength(count);
    if (count)
      expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
        expect.stringContaining(file),
      ]);
  },
);

test("missing registered handlers do not produce security diagnostics", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/handlers/current.ts": `export default defineEventHandler(() => ({}))`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        nuxtVersion: "4",
        vueVersion: "3.5",
        appDir: "app",
        serverHandlers: [
          { file: "server/handlers/account.ts", route: "/api/account" },
          { file: "server/handlers/current.ts", route: "/api/profile" },
        ],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
    expect.stringContaining("server/handlers/current.ts"),
  ]);
});

test.each([
  ["async (event) => { await requireAuth(event) }", undefined, undefined, 1],
  [
    "async (event) => { if (event.path === '/api/admin') await requireAuth(event) }",
    undefined,
    undefined,
    1,
  ],
  ["(event) => getUserSession(event)", undefined, undefined, 1],
  ["async (event) => { await requireAuth(event) }", "/api/admin/**", undefined, 1],
  ["async (event) => { await requireAuth(event) }", undefined, "GET", 1],
  ["async (event) => { await requireAuth(event) }", undefined, "post", 1],
])(
  "manifest-only middleware does not prove guard coverage for %s at %s with method %s",
  async (handler, route, method, count) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
        "server/handlers/auth.ts": `export default defineEventHandler(${handler})`,
        "server/handlers/data.ts": `export default defineEventHandler(() => ({}))`,
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: "2999-01-01T00:00:00.000Z",
          nuxtVersion: "4",
          vueVersion: "3.5",
          appDir: "app",
          serverHandlers: [
            { file: "server/handlers/auth.ts", middleware: true, route, method },
            { file: "server/handlers/data.ts", route: "/api/account", method: "POST" },
          ],
        }),
      },
    });
    expect(result.diagnostics).toHaveLength(count);
    if (count)
      expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
        expect.stringContaining("server/handlers/data.ts"),
      ]);
  },
);

test.each([
  ["2999-01-01T00:00:00.000Z", "get", 1, "GET"],
  ["2999-01-01T00:00:00.000Z", "post", 1, "GET"],
  ["2999-01-01T00:00:00.000Z", undefined, 1, "GET"],
  ["2000-01-01T00:00:00.000Z", "get", 1, "GET"],
  [undefined, "get", 1, "GET"],
  ["2000-01-01T00:00:00.000Z", "get", 1, undefined],
])(
  "registered middleware currency %s and file method %s",
  async (generatedAt, method, count, middlewareMethod) => {
    const file = `server/api/account${method ? `.${method}` : ""}.ts`;
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": `export default defineNuxtConfig({})`,
        "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
        "server/handlers/auth.ts": `export default defineEventHandler(async (event) => { await requireAuth(event) })`,
        [file]: `export default defineEventHandler(() => ({}))`,
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt,
          nuxtVersion: "4",
          vueVersion: "3.5",
          appDir: "app",
          serverHandlers: [
            { file: "server/handlers/auth.ts", middleware: true, method: middlewareMethod },
          ],
        }),
      },
    });
    expect(result.diagnostics).toHaveLength(count);
  },
);

test("route middleware security ignores sensitive ancestor directory names", async () => {
  await withFixture(
    {
      "user/project/package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
      "user/project/app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "user/project/server/api/feedback.get.ts": `export default defineEventHandler(() => [])`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root: join(root, "user/project"),
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noRouteMiddlewareApiSecurity],
                presets: { recommended: [noRouteMiddlewareApiSecurity.meta.id] },
              }),
            ],
          }),
        ],
      });
      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test.each(["mts", "cts", "cjs"])(
  "route middleware security includes %s handlers",
  async (extension) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
        "server/api/feedback.get.ts": `export default defineEventHandler(() => [])`,
        [`server/api/account.get.${extension}`]: `export default defineEventHandler(() => ({}))`,
      },
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
      expect.stringContaining(`server/api/account.get.${extension}`),
    ]);
  },
);

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
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [
          defineDoctorExtension({
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
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [
          defineDoctorExtension({
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
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
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
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
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
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
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
  github: { url: 'https://github.com/onmax/vite-doctor', branch: 'main', rootDir: 'docs' },
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
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
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
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
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
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
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
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
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
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("manifest import globs suppress configured nested composable warning", async () => {
  await withFixture(
    {
      "app/composables/npm/usePackage.ts": `export function usePackage() { return true }`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        importsDirs: ["~/composables", "~/composables/*/*.ts"],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("nuxt config import globs suppress nested composable warning without manifest", async () => {
  await withFixture(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({
  imports: {
    dirs: ["~/composables", "~/composables/*/*.ts"],
  },
})`,
      "app/composables/npm/usePackage.ts": `export function usePackage() { return true }`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("app-relative nuxt config import dirs suppress nested composable warning", async () => {
  await withFixture(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({
  imports: {
    dirs: ["./composables/masto"],
  },
})`,
      "app/composables/masto/account.ts": `export function useAccount() { return true }`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("nested composable warning ignores helper modules in composables folders", async () => {
  await withFixture(
    {
      "app/composables/tiptap/emoji.ts": `export const TiptapPluginEmoji = Node.create({ name: "emoji" })`,
      "app/composables/idb/index.ts": `export async function useAsyncIDBKeyval() { return true }`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.file).toContain("app/composables/idb/index.ts");
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
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noSubdirPluginAutoRegistrationAssumption],
                presets: { recommended: ["nuxt/plugins/no-subdir-auto-registration-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("explicit auto-import rule follows the resolved Nuxt registry and configuration", async () => {
  async function runCase(
    source: string,
    manifest: Record<string, unknown> = {},
    file = "app/components/Alerts/Shared/ListMessage.vue",
    severity?: "error",
  ) {
    let diagnostics: Awaited<ReturnType<typeof runDoctor>>["diagnostics"] = [];
    await withFixture(
      {
        [file]: `<script setup lang="ts">${source}</script>`,
        "app/utils/alerts.ts": `export function getAlertListValue() { return '' }`,
      },
      {},
      async (root) => {
        await writeFileManifest(root, [], {
          generatedAt: new Date().toISOString(),
          autoImportEnabled: true,
          autoImports: [
            {
              name: "getAlertListValue",
              as: "getAlertListValue",
              from: join(root, "app/utils/alerts.ts"),
            },
          ],
          ...manifest,
        });
        const result = await runDoctor({
          root,
          framework: "nuxt",
          config: severity
            ? { rules: { "nuxt/imports/no-explicit-auto-import": severity } }
            : undefined,
          runtimeTarget: { nuxt: "4.0.0" },
          extensions: [
            defineDoctorExtension({
              name: "fixture",
              rulePacks: [
                defineRulePack({
                  name: "fixture",
                  version: "0.0.0",
                  rules: [noExplicitAutoImport],
                  presets: { recommended: ["nuxt/imports/no-explicit-auto-import"] },
                }),
              ],
            }),
          ],
        });
        diagnostics = result.diagnostics;
      },
    );
    return diagnostics;
  }

  const portalImport = await runCase(
    `import { getAlertListValue } from '~/utils/alerts'\ngetAlertListValue()`,
  );
  expect(portalImport).toHaveLength(1);
  expect(portalImport[0]).toMatchObject({
    ruleId: "nuxt/imports/no-explicit-auto-import",
    severity: "warn",
  });
  expect(portalImport[0]?.fix?.kind).toBe("safe");

  const blockingPortalImport = await runCase(
    `import { getAlertListValue } from '#imports'\ngetAlertListValue()`,
    {},
    "app/components/Alerts/Shared/ListMessage.vue",
    "error",
  );
  expect(blockingPortalImport[0]?.severity).toBe("error");

  expect(
    await runCase(`import { getAlertListValue } from 'other-package'\ngetAlertListValue()`),
  ).toHaveLength(0);
  expect(
    await runCase(`import type { getAlertListValue } from '~/utils/alerts'`, {}, "app/types.ts"),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue as localValue } from '~/utils/alerts'\nlocalValue()`),
  ).toHaveLength(0);
  expect(
    await runCase(
      `import { getAlertListValue } from '~/utils/alerts'\ngetAlertListValue()`,
      {},
      "server/api/alerts.ts",
    ),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue } from '~/utils/alerts'`, {
      autoImportEnabled: false,
    }),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue } from '~/utils/alerts'`, {
      generatedAt: "invalid",
    }),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue } from '~/utils/alerts'`, {
      autoImportEnabled: undefined,
    }),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue } from '~/utils/alerts'`, {
      autoImportTransform: {
        include: [],
        exclude: [{ source: "ListMessage\\.vue$", flags: "" }],
      },
    }),
  ).toHaveLength(0);
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

test("Nuxt module exposes native Doctor config", async () => {
  expect(await nuxtDoctorModule.getMeta?.()).toEqual({
    name: "vite-doctor",
    configKey: "doctor",
    compatibility: { nuxt: ">=4.1.0" },
    docs: "https://vite-doctor.onmax.me/nuxt",
  });
});

test("Nuxt module records the resolved auto-import registry", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, Array<(payload: any) => unknown>>();
    const nuxt = {
      _version: "4.5.1",
      options: {
        rootDir: root,
        srcDir: "app",
        buildDir: ".nuxt",
        modules: [],
        imports: {
          autoImport: true,
          imports: [],
          transform: { exclude: [/generated/] },
        },
      },
      hook(name: string, callback: (payload: any) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), callback]);
      },
      async callHook() {},
    };

    await nuxtDoctorModule({}, nuxt as any);
    for (const hook of hooks.get("imports:context") ?? [])
      await hook({
        getImports: async () => [
          {
            name: "getAlertListValue",
            as: "getAlertListValue",
            from: join(root, "app/utils/alerts.ts"),
          },
        ],
      });
    for (const hook of hooks.get("prepare:types") ?? []) await hook(undefined);

    expect(
      JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8")),
    ).toMatchObject({
      appDir: join(root, "app"),
      autoImportEnabled: true,
      autoImportTransform: {
        exclude: [{ source: "generated", flags: "" }],
      },
      autoImports: [
        {
          name: "getAlertListValue",
          as: "getAlertListValue",
          from: join(root, "app/utils/alerts.ts"),
        },
      ],
    });
  });
});

test("Nuxt module timestamps changed evidence without rewriting identical manifests", async () => {
  await withFixture({}, {}, async (root) => {
    const nuxt = {
      options: {
        rootDir: root,
        buildDir: ".nuxt",
        modules: [],
        future: { compatibilityVersion: 4 },
      },
    };

    const first = await writeManifest(nuxt);
    const unchanged = await writeManifest(nuxt);
    expect(unchanged.generatedAt).toBe(first.generatedAt);

    await new Promise((resolve) => setTimeout(resolve, 2));
    nuxt.options.future.compatibilityVersion = 5;
    const changed = await writeManifest(nuxt);

    expect(changed.generatedAt! > first.generatedAt!).toBe(true);
    expect(
      JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8")),
    ).toMatchObject({
      generatedAt: changed.generatedAt,
      compatibilityVersion: 5,
    });
  });
});

test("Nuxt module recreates an unchanged manifest after the build directory is cleaned", async () => {
  await withFixture({}, {}, async (root) => {
    const nuxt = {
      options: { rootDir: root, buildDir: ".nuxt", modules: [] },
    };

    const first = await writeManifest(nuxt);
    const manifestPath = join(root, ".nuxt/doctor.manifest.json");
    await rm(join(root, ".nuxt"), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const recreated = await writeManifest(nuxt);

    expect(existsSync(manifestPath)).toBe(true);
    expect(recreated.generatedAt).not.toBe(first.generatedAt);
  });
});

test("Nuxt module writes Doctor config and Doctor Run applies it", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup lang="ts">
import { useRoute } from "vue-router";
useRoute();
</script>`,
    },
    {},
    async (root) => {
      const nuxt = {
        _version: "4.5.1",
        options: { rootDir: root, buildDir: ".nuxt", modules: [] },
        async callHook() {},
      };

      await nuxtDoctorModule(
        {
          rules: { "nuxt/routing/prefer-nuxt-useroute": "off" },
        },
        nuxt as any,
      );
      await writeManifest(nuxt);

      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.doctorConfig).toEqual({
        rules: { "nuxt/routing/prefer-nuxt-useroute": "off" },
      });

      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: {
          nuxt: "4.0.0",
          nitro: "2.0.0",
          h3: "1.0.0",
          vue: "3.5.0",
          nuxtCompatibility: 4,
        },
        extensions: nuxtDoctorExtensions(),
      });
      expect(result.diagnostics.map((item) => item.ruleId)).not.toContain(
        "nuxt/routing/prefer-nuxt-useroute",
      );
      expect(existsSync(join(root, ".nuxt/doctor/cache"))).toBe(true);
      expect(existsSync(join(root, ".vite-doctor"))).toBe(false);
    },
  );
});

test("Nuxt module writes evidence fields and text report shows evidence summary", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<template><div /></template>`,
      "server/api/user.ts": `export default defineEventHandler(() => ({ ok: true }))`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        pages: [{ path: "/", file: join(root, "app/pages/index.vue"), name: "index" }],
        prerenderRoutes: ["/"],
        buildManifest: {
          hasBuildManifest: true,
          chunks: [{ file: "entry.mjs", src: "app/pages/index.vue", isEntry: true }],
        },
        serverHandlers: [{ route: "/api/user", file: "server/api/user.ts", method: "GET" }],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [] })],
      });
      const report = createTextReport(result);

      expect(result.project.nuxt?.manifest?.evidence).toEqual({
        routeGraph: true,
        buildManifest: true,
        prerenderRoutes: 1,
        serverRoutes: 1,
      });
      expect(report).toContain(
        "Evidence used: manifest present, route graph present, build manifest present, 1 prerender routes, 1 server routes",
      );
      expect(report).toContain("Confidence mix: 0 proven, 0 probable, 0 source-only");
    },
  );
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
              ctx.report(
                allDiagnostics.DOC9999({
                  why: "Hook rule ran.",
                  fix: "Inspect the Nuxt hook rule.",
                }),
                {
                  ruleId: "fixture/nuxt-hook-rule",
                  severity: "error",
                  category: "architecture",
                  file: ctx.file.path,
                },
              );
            },
          };
        },
      });

      const rulePacks = await collectNuxtDoctorRulePacks({
        async callHook(name: string, packs: any[]) {
          if (name !== "doctor:extendRules") return;
          packs.push(
            defineRulePack({
              name: "fixture",
              version: "0.0.0",
              rules: [hookRule],
              presets: { recommended: ["fixture/nuxt-hook-rule"] },
            }),
          );
        },
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toContain("fixture/nuxt-hook-rule");
    },
  );
});

test("Nuxt runtime evidence classifies setup, client, server, lifecycle, command, and unknown execution", async () => {
  const evidenceRule = createRule({
    meta: {
      id: "test/nuxt-runtime-evidence",
      title: "Nuxt runtime evidence",
      category: "architecture",
      severity: "info",
      requires: { script: true, nuxt: true },
    },
    create(ctx) {
      const evidence = createNuxtRuntimeEvidence(ctx);
      return {
        ScriptNode(node: any) {
          if (!ctx.helpers.isCall(node, "mark")) return;
          ctx.report(
            allDiagnostics.DOC9999({
              why: evidence.executionFor(node),
              fix: "Inspect the Nuxt runtime evidence.",
            }),
            {
              ruleId: "test/nuxt-runtime-evidence",
              severity: "info",
              category: "architecture",
              file: ctx.file.path,
              range: ctx.range(node),
            },
          );
        },
      };
    },
  });

  const result = await runRuleFixture({
    rule: evidenceRule,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
mark('setup')
function handleClick() { mark('event') }
onMounted(() => mark('lifecycle'))
const commands = { open() { mark('command') } }
function helper() { mark('unknown') }
</script>
<template><button @click="handleClick">Open</button></template>`,
      "server/api/user.ts": `export default defineEventHandler(() => mark('server'))`,
      "app/plugins/client.client.ts": `mark('client')`,
      "app/utils/evidence.ts": `function helper() { mark('unknown') }`,
    },
  });

  expect(result.diagnostics.map((item) => item.message).sort()).toEqual([
    "client-only",
    "client-only",
    "event-handler",
    "returned-command",
    "server-only",
    "setup-time",
    "unknown",
  ]);
});

test("Nuxt Doctor rule payloads use JSON report helpers", () => {
  const rules = JSON.parse(createRulesReport(nuxtRulePacks(), "json"));
  expect(rules.rules.map((rule: any) => rule.pack)).toEqual(
    expect.arrayContaining([
      "vite-doctor/nitro",
      "vite-doctor/nuxt",
      "vite-doctor/nuxt-content",
      "vite-doctor/nuxt-ui",
      "vite-doctor/nuxt-scripts",
      "vite-doctor/vueuse",
      "vite-doctor/nuxt-image",
      "vite-doctor/nuxthub",
      "vite-doctor/nuxt-better-auth",
      "vite-doctor/docus",
    ]),
  );

  const explanation = JSON.parse(
    explainRule(nuxtRulePacks(), "nuxt/fetch/no-raw-fetch-in-setup", "json"),
  );
  expect(explanation.id).toBe("nuxt/fetch/no-raw-fetch-in-setup");
  expect(explainRule(nuxtRulePacks(), "nuxt/does-not-exist", "json")).toBe("");
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
              ctx.report(
                allDiagnostics.DOC9999({
                  why: `${ctx.file.moduleName}:${ctx.file.relativePath}`,
                  fix: "Inspect the module source fixture.",
                }),
                {
                  ruleId: "fixture/module-source",
                  severity: "error",
                  category: "architecture",
                  file: ctx.file.path,
                },
              );
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
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [moduleRule],
                presets: { recommended: ["fixture/module-source"] },
              }),
            ],
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
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noBrowserGlobalInUniversalCode],
                presets: {
                  recommended: ["nuxt/hydration/no-browser-global-in-universal-code"],
                },
              }),
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
        runtimeTarget: {
          nuxt: "4.0.0",
          nitro: "2.0.0",
          h3: "1.0.0",
          vue: "3.5.0",
          nuxtCompatibility: 4,
        },
        extensions: nuxtDoctorExtensions(),
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("vite-doctor exits 1 for Nuxt errors and 0 for warnings unless max warnings is zero", async () => {
  await withFixture(
    {
      "app/pages/error.vue": `<script setup>const width = window.innerWidth</script>`,
      "app/pages/warn.vue": `<script setup>const theme = localStorage.getItem('theme')</script>`,
    },
    {},
    async (root) => {
      expect(
        await main([root, "--rules", "nuxt/hydration/no-browser-global-in-universal-code"]),
      ).toBe(1);
      expect(
        await main([root, "--rules", "nuxt/hydration/prefer-usecookie-for-initial-client-state"]),
      ).toBe(0);
      expect(
        await main([
          root,
          "--rules",
          "nuxt/hydration/prefer-usecookie-for-initial-client-state",
          "--max-warnings",
          "0",
        ]),
      ).toBe(1);
    },
  );
}, 30000);

test("vite-doctor stores Nuxt cache inside the Nuxt build directory", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup>const width = window.innerWidth</script>`,
    },
    {},
    async (root) => {
      await main([root, "--rules", "nuxt/hydration/no-browser-global-in-universal-code"]);

      expect(existsSync(join(root, ".nuxt/doctor/cache"))).toBe(true);
      expect(existsSync(join(root, ".vite-doctor"))).toBe(false);
      expect(existsSync(join(root, ".vue-doctor"))).toBe(false);
    },
  );
}, 30000);

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
    const runtimePackages = {
      "node_modules/nuxt/package.json": JSON.stringify({
        name: "nuxt",
        version: "4.0.0",
        dependencies: { nitropack: "2.12.0" },
      }),
      "node_modules/nuxt/node_modules/nitropack/package.json": JSON.stringify({
        name: "nitropack",
        version: "2.12.0",
        dependencies: { h3: "1.15.4" },
      }),
      "node_modules/nuxt/node_modules/nitropack/node_modules/h3/package.json": JSON.stringify({
        name: "h3",
        version: "1.15.4",
      }),
      "node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.18" }),
    };
    for (const [file, text] of Object.entries(runtimePackages)) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
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

test.each([true, false])(
  "Nuxt manifest preserves layer alias directories and setting: %s",
  async (localLayerAliases) => {
    await withFixture({}, {}, async (root) => {
      const layerRoot = join(root, "layers/admin");
      await writeManifest({
        options: {
          rootDir: root,
          buildDir: ".nuxt",
          modules: [],
          experimental: { localLayerAliases },
          _layers: [
            {
              cwd: layerRoot,
              config: {
                rootDir: layerRoot,
                srcDir: join(layerRoot, "src"),
                dir: { middleware: "guards" },
                serverDir: join(layerRoot, "backend"),
              },
            },
          ],
        },
        async callHook() {},
      });
      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.localLayerAliases).toBe(localLayerAliases);
      expect(manifest.layers[0]).toMatchObject({
        root: layerRoot,
        srcDir: join(layerRoot, "src"),
        appMiddlewareDir: join(layerRoot, "src/guards"),
        serverDir: join(layerRoot, "backend"),
      });
    });
  },
);

test.each([undefined, "2000-01-01T00:00:00.000Z"])(
  "ignores stale registered handlers with timestamp %s",
  async (generatedAt) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": "export default defineNuxtConfig({})",
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/handlers/data.ts": "export default defineEventHandler(() => ({}))",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt,
          serverHandlers: [{ file: "server/handlers/data.ts", route: "/api/account" }],
        }),
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

test("session lookup alone does not protect a sensitive handler", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts":
        "export default defineEventHandler(async event => { const session = await getUserSession(event); return { private: true } })",
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  "import { requireAuth } from './auth'; export default defineEventHandler(() => ({ private: true }))",
  "export default defineEventHandler(() => { /* requireAuth(event) */ return { private: true } })",
  "export default defineEventHandler(event => { const unused = () => requireAuth(event); return { private: true } })",
  "export default defineEventHandler(() => ({ note: 'requireAuth(event)' }))",
])("unused guard references do not protect a sensitive handler: %s", async (handler) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": handler,
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  "",
  "import { toWebRequest } from 'h3';",
  "import { toWebRequest } from '#imports';",
  "import { toWebRequest as toRequest } from 'h3';",
  "function unrelated() { var toWebRequest = () => new Request('https://example.com') }",
  "if (true) { const toWebRequest = () => new Request('https://example.com') }",
])(
  "standard auth provider catch-all delegates authorization to the provider: %s",
  async (converter) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/auth/[...all].ts": `${converter} import { auth } from '../../utils/auth'; export default defineEventHandler(event => auth.handler(${converter.includes("as toRequest") ? "toRequest" : "toWebRequest"}(event)))`,
        "server/utils/auth.ts":
          "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

test("provider catch-all permits setup before terminal delegation", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { setHeader(event, 'x-auth', 'yes'); return auth.handler(toWebRequest(event)) })",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("provider catch-all accepts the H3 eventHandler wrapper", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { eventHandler } from 'h3'; import { auth } from '../../utils/auth'; export default eventHandler(event => auth.handler(toWebRequest(event)))",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("provider catch-all accepts Nuxt's auto-imported eventHandler wrapper", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '../../utils/auth'; export default eventHandler(event => auth.handler(toWebRequest(event)))",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  "function eventHandler(callback) { return callback };",
  "import { eventHandler } from './unrelated';",
  "if (true) { var eventHandler = callback => callback }",
  "for (var eventHandler of []) {}",
  "try { var eventHandler = callback => callback } catch {}",
])("provider catch-all does not trust an unrelated eventHandler binding: %s", async (binding) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts": `${binding} import { auth } from '../../utils/auth'; export default eventHandler(event => auth.handler(toWebRequest(event)))`,
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test.each([
  ...[
    "if (true) { var toWebRequest = () => new Request('https://example.com') }",
    "for (var toWebRequest of []) {}",
    "try { var toWebRequest = () => new Request('https://example.com') } catch {}",
  ].map(
    (declaration) =>
      `import { auth } from '../../utils/auth'; ${declaration}; export default defineEventHandler(event => auth.handler(toWebRequest(event)))`,
  ),
  "import { auth } from '../../utils/auth'; export default defineEventHandler(function toWebRequest(event) { return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { const toWebRequest = customConverter; return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { const { toWebRequest } = customConverters; return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; import { toWebRequest as toRequest } from 'h3'; export default defineEventHandler(event => { const toRequest = customConverter; return auth.handler(toRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler((event, toWebRequest) => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; const toWebRequest = () => new Request('https://example.com'); export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; import { toWebRequest } from './unrelated'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; function toWebRequest() { return new Request('https://example.com') }; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(toWebRequest => auth.handler(toWebRequest(toWebRequest)))",
  "const auth = { handler: () => ({ private: true }) }; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from './unrelated'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => auth.handler())",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(other)))",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(auth => auth.handler(toWebRequest(auth)))",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { const auth = { handler() {} }; return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { const { auth } = { auth: { handler() {} } }; return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(function auth(event) { return auth.handler(toWebRequest(event)) })",
])(
  "provider-shaped calls without provenance or request delegation remain sensitive: %s",
  async (handler) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/auth/[...all].ts": handler,
        "server/api/auth/unrelated.ts":
          "export const auth = { handler: () => ({ private: true }) }",
        "server/utils/auth.ts":
          "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
      },
    });
    expect(
      result.diagnostics.some((item) => item.file.endsWith("server/api/auth/[...all].ts")),
    ).toBe(true);
  },
);

test.each(["~/utils/auth", "@/utils/auth", "~~/app/utils/auth", "@@/app/utils/auth"])(
  "auth providers resolve Nuxt alias %s",
  async (source) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/auth/[...all].ts": `import { auth } from '${source}'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))`,
        "app/utils/auth.ts":
          "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each([true, false])("aliased auth providers require provenance: %s", async (supported) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "custom/utils/auth.ts": supported
        ? "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})"
        : "export const auth = { handler: () => ({ private: true }) }",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        nuxtVersion: "4",
        vueVersion: "3.5",
        appDir: "app",
        aliases: { "~": "custom" },
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(supported ? 0 : 1);
});

test.each([
  ["auth/register.post.ts", "delete", 1],
  ["auth/register.ts", "post", 0],
  ["auth/register.get.ts", "post", 0],
  ["auth/register.post.ts", undefined, 1],
])("registered auth handler %s uses registration method %s", async (file, method, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      [`server/handlers/${file}`]: `export default defineEventHandler(() => ({}))`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        appDir: "app",
        serverHandlers: [{ file: `server/handlers/${file}`, route: "/api/auth/register", method }],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  [
    "const handler = defineEventHandler(async event => { await requireAuth(event) }); export default handler",
    0,
  ],
  [
    "const handler = eventHandler(event => requireAuth(event)); const alias = handler; export default alias",
    0,
  ],
  ["const handler = defineEventHandler(() => ({})); export default handler", 1],
  ["const handler = alias; const alias = handler; export default handler", 1],
  [
    "let handler = defineEventHandler(event => requireAuth(event)); handler = defineEventHandler(() => ({})); export default handler",
    1,
  ],
])("exported handler bindings preserve guard coverage: %s", async (source, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/api/account.get.ts": source,
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["import { betterAuth } from 'better-auth'; export default betterAuth({})", 0],
  ["import { betterAuth as createAuth } from 'better-auth'; export default createAuth({})", 0],
  [
    "import { betterAuth } from 'better-auth'; const instance = betterAuth({}); export default instance",
    0,
  ],
  ["const betterAuth = () => ({}); export default betterAuth({})", 1],
  ["export default { handler: request => request }", 1],
])("default provider imports require Better Auth provenance: %s", async (provider, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import auth from '#auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "app/utils/auth.ts": provider,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        aliases: { "#auth": "app/utils/auth.ts" },
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each(["ts", "js", "mts", "mjs", "cts", "cjs"])(
  "auth providers resolve directory index.%s with provenance",
  async (extension) => {
    for (const supported of [true, false]) {
      const result = await runRuleFixture({
        rule: noRouteMiddlewareApiSecurity,
        framework: "nuxt",
        files: {
          "app/middleware/auth.ts":
            "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
          "server/api/auth/[...all].ts":
            "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
          [`app/utils/auth/index.${extension}`]: supported
            ? "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})"
            : "export const auth = { handler: () => ({ private: true }) }",
        },
      });
      expect(result.diagnostics).toHaveLength(supported ? 0 : 1);
    }
  },
);

test.each([
  ["const auth = betterAuth({}); export { auth }", 0],
  ["const instance = betterAuth({}); export { instance as auth }", 0],
  ["const auth = { handler: () => ({}) }; export { auth }", 1],
  ["const auth = betterAuth({}); export { auth } from './other'", 1],
  ["const auth = betterAuth({}); export type { auth }", 1],
])("provider export lists require local provenance: %s", async (provider, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "app/utils/auth.ts": `import { betterAuth } from 'better-auth'; ${provider}`,
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["export { auth } from './server'", "export const auth = betterAuth({})", 0],
  ["export { instance as auth } from './server'", "export const instance = betterAuth({})", 0],
  ["export { auth } from './server'", "export const auth = { handler: () => ({}) }", 1],
  ["export { auth } from './server'", "const auth = betterAuth({})", 1],
  ["import { auth } from './server'; export { auth }", "export const auth = betterAuth({})", 0],
  [
    "import { instance as auth } from './server'; export { auth }",
    "export const instance = betterAuth({})",
    0,
  ],
  [
    "import { auth } from './server'; export { auth }",
    "export const auth = { handler: () => ({}) }",
    1,
  ],
  ["export { auth } from './auth'", "export { auth } from './index'", 1],
])("provider re-exports require exported provenance: %s", async (barrel, provider, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "app/utils/auth/index.ts": barrel,
      "app/utils/auth/server.ts": `import { betterAuth } from 'better-auth'; ${provider}`,
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test("Nuxt module captures and refreshes Nitro's resolved handlers", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    const nitroHooks = new Map<string, () => unknown>();
    const nuxt = {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    };
    await nuxtDoctorModule({}, nuxt as any);
    const nitro = {
      options: {
        dev: false,
        preset: "node-server",
        handlers: [{ handler: join(root, "custom/account.ts"), route: "/api/account" }],
      },
      scannedHandlers: [
        {
          handler: join(root, "layer/profile.ts"),
          route: "/api/profile",
          method: "get",
          env: "prod",
        },
        { handler: join(root, "layer/debug.ts"), route: "/api/admin", env: "dev" },
        { handler: join(root, "layer/guard.ts"), middleware: true, env: ["prod", "prerender"] },
      ],
      hooks: { hook: (name: string, callback: () => unknown) => nitroHooks.set(name, callback) },
    };
    await hooks.get("nitro:init")!(nitro);
    const readHandlers = () =>
      JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"))
        .resolvedServerHandlers;
    expect(readHandlers()).toEqual([
      { file: "layer/profile.ts", route: "/api/profile", method: "get" },
      { file: "layer/guard.ts", middleware: true },
      { file: "custom/account.ts", route: "/api/account" },
    ]);
    nitro.scannedHandlers = [];
    await nitroHooks.get("compiled")!();
    await hooks.get("prepare:types")!();
    expect(readHandlers()).toEqual([{ file: "custom/account.ts", route: "/api/account" }]);
    nitro.options.handlers = [];
    await nitroHooks.get("rollup:before")!();
    expect(readHandlers()).toEqual([]);
  });
});

test.each([
  "unguarded",
  "guarded",
  "scoped-guard",
  "matching-scope",
  "method-guard",
  "matching-method",
  "empty",
])("NUXT0037 uses resolved layer handlers and middleware: %s", async (state) => {
  const handler = "layers/admin/backend/api/account.ts";
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      [handler]: "export default defineEventHandler(() => ({ private: true }))",
      "layers/admin/backend/api/health.ts": "export default defineEventHandler(() => 'ok')",
      "layers/admin/backend/middleware/auth.ts":
        "export default defineEventHandler(event => requireUserSession(event))",
      "server/api/profile.ts": "export default defineEventHandler(() => ({ ignored: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [{ root: "layers/admin", serverDir: "layers/admin/backend", priority: 0 }],
        resolvedServerHandlers:
          state === "empty"
            ? []
            : [
                {
                  file: handler,
                  route: "/api/account",
                  method: state === "matching-method" ? "get" : undefined,
                },
                { file: "layers/admin/backend/api/health.ts", route: "/api/health" },
                ...(state === "unguarded"
                  ? []
                  : [
                      {
                        file: "layers/admin/backend/middleware/auth.ts",
                        middleware: true,
                        route:
                          state === "scoped-guard"
                            ? "/api/admin/**"
                            : state === "matching-scope"
                              ? "/api/**"
                              : undefined,
                        method:
                          state === "method-guard"
                            ? "post"
                            : state === "matching-method"
                              ? "get"
                              : undefined,
                      },
                    ]),
              ],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(
    ["guarded", "matching-scope", "matching-method", "empty"].includes(state) ? 0 : 1,
  );
  if (result.diagnostics.length)
    expect(result.diagnostics[0]!.related?.map((item) => item.file)).toEqual([
      expect.stringContaining(handler),
    ]);
});

test("NUXT0037 finds auto-registered layer middleware with a stale manifest", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      "layers/old/app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2000-01-01T00:00:00.000Z",
        appDir: "layers/old/app",
        layers: [
          {
            root: "layers/old",
            srcDir: "layers/old/app",
            appMiddlewareDir: "layers/old/app/middleware",
            priority: 0,
          },
        ],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 keeps configured middleware when only server inventory is stale", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "src/guards/auth.ts": "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        appDir: "src",
        layers: [{ root: ".", srcDir: "src", appMiddlewareDir: "src/guards", priority: 0 }],
        serverInventory: { server: [] },
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 discovers configured source and middleware directories without a manifest", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts":
        "export default defineNuxtConfig({ srcDir: 'src', dir: { middleware: 'guards' } })",
      "src/guards/auth.ts": "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 discovers auto-registered layer handlers without a manifest", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "layers/admin/server/api/account.get.ts":
        "export default defineEventHandler(() => ({ private: true }))",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 uses root middleware when a layer app directory has no effective contents", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "layers/admin/app/router.options.ts": "export default {}",
      "layers/admin/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "layers/admin/server/api/account.get.ts":
        "export default defineEventHandler(() => ({ private: true }))",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 ignores unrelated middleware options without a manifest", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts":
        "export default defineNuxtConfig({ nitro: { handlers: [{ handler: './guard', middleware: true }] } })",
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test.each([
  "const source = 'src'; export default defineNuxtConfig({ srcDir: source })",
  "export default defineNuxtConfig({ serverDir: 'backend' })",
])(
  "NUXT0037 records an evidence gap for unresolved config without a manifest: %s",
  async (config) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": config,
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      },
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(
      0,
    );
    expect(
      result.project.evidenceGaps?.some(
        (gap) => gap.source === "vite-doctor/nuxt-middleware-api-security",
      ),
    ).toBe(true);
  },
);

test.each([
  ["identifier keys", "srcDir: 'src'", "middleware"],
  ["quoted keys", '"srcDir": "src", dir: { "middleware": "guards" }', "guards"],
])(
  "NUXT0037 finds the current root source directory after config changes with %s",
  async (_label, config, middlewareDir) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": `export default defineNuxtConfig({ ${config} })`,
        [`src/${middlewareDir}/auth.ts`]:
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: "2000-01-01T00:00:00.000Z",
          appDir: "layers/old/app",
          layers: [{ root: "layers/old", srcDir: "layers/old/app", priority: 0 }],
        }),
      },
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(
      1,
    );
  },
);

test("NUXT0037 ignores stale registered handlers when server inventory changes", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/handlers/account.ts": "export default defineEventHandler(() => ({ private: true }))",
      "server/api/health.ts": "export default defineEventHandler(() => 'ok')",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        serverInventory: { server: [] },
        serverHandlers: [{ file: "server/handlers/account.ts", route: "/api/account" }],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(0);
});

test("NUXT0037 finds new layer handlers when resolved server inventory is stale", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "layers/admin/backend/api/account.get.ts":
        "export default defineEventHandler(() => ({ private: true }))",
      "layers/admin/backend/api/health.get.ts":
        "export default defineEventHandler(() => ({ public: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [{ root: "layers/admin", serverDir: "layers/admin/backend", priority: 0 }],
        serverInventory: { "layers/admin/backend": [] },
        resolvedServerHandlers: [],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
  expect(result.diagnostics[0]?.file).toContain("account.get.ts");
});

test("NUXT0037 finds new root handlers under a configured serverDir", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "backend/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [{ root: ".", serverDir: "backend", priority: 0 }],
        serverInventory: { backend: [] },
        resolvedServerHandlers: [],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
  expect(result.diagnostics[0]?.file).toContain("account.get.ts");
});

test.each(["login.post.ts", "sign-in.post.ts", "signin.post.ts", "callback.get.ts"])(
  "NUXT0037 ignores public layer endpoint %s when resolved server inventory is stale",
  async (endpoint) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        [`layers/admin/backend/api/auth/${endpoint}`]:
          "export default defineEventHandler(() => ({ public: true }))",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: "2100-01-01T00:00:00.000Z",
          layers: [{ root: "layers/admin", serverDir: "layers/admin/backend", priority: 0 }],
          serverInventory: { "layers/admin/backend": [] },
          resolvedServerHandlers: [],
        }),
      },
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(
      0,
    );
  },
);

test("NUXT0037 records an evidence gap for nonliteral changed middleware configuration", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": "const source = 'src'; export default defineNuxtConfig({ srcDir: source })",
      "src/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2000-01-01T00:00:00.000Z",
        appDir: "app",
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(0);
  expect(
    result.project.evidenceGaps?.some(
      (gap) => gap.source === "vite-doctor/nuxt-middleware-api-security",
    ),
  ).toBe(true);
});

test("NUXT0037 requires fresh evidence when changed config moves the server directory", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({ serverDir: 'backend' })",
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "backend/api/account.ts": "export default defineEventHandler(() => ({ private: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2000-01-01T00:00:00.000Z",
        appDir: "app",
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(0);
  expect(
    result.project.evidenceGaps?.some(
      (gap) => gap.source === "vite-doctor/nuxt-middleware-api-security",
    ),
  ).toBe(true);
});

test("NUXT0037 does not treat differently cased methods as matching constraints", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.ts": "export default defineEventHandler(() => ({ private: true }))",
      "server/middleware/auth.ts":
        "export default defineEventHandler(event => requireUserSession(event))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        resolvedServerHandlers: [
          { file: "server/api/account.ts", route: "/api/account", method: "GET" },
          { file: "server/middleware/auth.ts", middleware: true, method: "get" },
        ],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test.each([true, false])("provider aliases follow localLayerAliases: %s", async (enabled) => {
  const handler = "layers/admin/server/api/auth/[...all].ts";
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      [handler]:
        "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "layers/admin/app/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        localLayerAliases: enabled,
        layers: [{ root: "layers/admin", srcDir: "layers/admin/app", priority: 0 }],
        resolvedServerHandlers: [{ file: handler, route: "/api/auth/**" }],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(enabled ? 0 : 1);
});

test("Nuxt captures cached wildcard overlaps and nested cache exclusions", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    const nuxt = {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    };
    await nuxtDoctorModule({}, nuxt as any);
    await hooks.get("nitro:init")!({
      options: {
        handlers: [{ handler: join(root, "custom/entry.ts"), route: "/api/**", method: "get" }],
        routeRules: {
          "/api/account": { cache: { maxAge: 60 } },
          "/api/admin/**": { cache: { maxAge: 60 } },
          "/api/admin/settings": { cache: false },
          "/api/profile": { cache: false },
          "/outside/account": { cache: { maxAge: 60 } },
        },
      },
      scannedHandlers: [],
      hooks: { hook() {} },
    });
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.resolvedServerHandlers.map((handler: any) => handler.route)).toEqual([
      "/api/account",
      "/api/admin/settings",
      "/api/admin/**",
      "/api/**",
    ]);
    expect(manifest.resolvedServerHandlers.every((handler: any) => handler.method === "get")).toBe(
      true,
    );
  });
});

test("Nuxt expands cached routes using the first registered wildcard handler", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    await nuxtDoctorModule({}, {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    } as any);
    await hooks.get("nitro:init")!({
      options: {
        handlers: [
          { handler: join(root, "custom/generic.ts"), route: "/api/**" },
          { handler: join(root, "custom/admin.ts"), route: "/api/admin/**" },
        ],
        routeRules: { "/api/admin/account": { cache: { maxAge: 60 } } },
      },
      scannedHandlers: [],
      hooks: { hook() {} },
    });
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(
      manifest.resolvedServerHandlers.find((handler: any) => handler.route === "/api/admin/account")
        ?.file,
    ).toBe("custom/generic.ts");
  });
});

test("Nuxt inventories registered handlers outside server directories", async () => {
  await withFixture(
    { "custom/account.ts": "export default defineEventHandler(() => ({}))" },
    {},
    async (root) => {
      const hooks = new Map<string, (payload?: any) => unknown>();
      await nuxtDoctorModule({}, {
        _version: "4.5.1",
        options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
        hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
        async callHook() {},
      } as any);
      const file = join(root, "custom/account.ts");
      await hooks.get("nitro:init")!({
        options: { handlers: [{ handler: file, route: "/api/account" }] },
        scannedHandlers: [],
        hooks: { hook() {} },
      });
      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.serverInventory[join(root, "custom")]).toEqual(["account.ts"]);
      expect(manifest.serverHandlerMtimes[file]).toEqual(expect.any(Number));
    },
  );
});

test("cached wildcard overlap respects route segment boundaries", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    const nuxt = {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    };
    await nuxtDoctorModule({}, nuxt as any);
    await hooks.get("nitro:init")!({
      options: {
        handlers: [{ handler: join(root, "custom/entry.ts"), route: "/api/ad/**" }],
        routeRules: { "/api/admin": { cache: { maxAge: 60 } } },
      },
      scannedHandlers: [],
      hooks: { hook() {} },
    });
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.resolvedServerHandlers.map((handler: any) => handler.route)).toEqual([
      "/api/ad/**",
    ]);
  });
});

test.each(["changed", "since"])(
  "NUXT0037 reports changed handlers with unchanged middleware: %s",
  async (mode) => {
    await withFixture(
      {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/account.get.ts": "export default defineEventHandler(() => ({ public: true }))",
      },
      {},
      async (root) => {
        const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
        git("init");
        git("add", ".");
        git(
          "-c",
          "user.name=Doctor",
          "-c",
          "user.email=doctor@example.com",
          "commit",
          "-m",
          "fixture",
        );
        writeFileSync(
          join(root, "server/api/account.get.ts"),
          "export default defineEventHandler(() => ({ private: true }))",
        );
        const result = await runDoctor({
          root,
          framework: "nuxt",
          ...(mode === "changed" ? { changed: true } : { since: "HEAD" }),
          extensions: [
            defineDoctorExtension({
              name: "nuxt-auth-scope",
              rulePacks: [
                defineRulePack({
                  name: "nuxt-auth-scope",
                  version: "1",
                  rules: [noRouteMiddlewareApiSecurity],
                  presets: { recommended: [noRouteMiddlewareApiSecurity.meta.id] },
                }),
              ],
            }),
          ],
        });
        expect(
          result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037"),
        ).toHaveLength(1);
        expect(result.diagnostics.find((diagnostic) => diagnostic.code === "NUXT0037")?.file).toBe(
          join(root, "server/api/account.get.ts"),
        );
      },
    );
  },
);
