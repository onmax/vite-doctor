import { expect, test } from "vite-plus/test";
import {
  noBrowserGlobalInUniversalCode,
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
  requireStableAsyncDataKey,
  asyncDataNoMutationMethods,
  noManualActionUseFetch,
  asyncDataHandlerPure,
  previewModeGlobalRefresh,
  noGlobalRefreshWithoutJustification,
  asyncDataExplicitKeyForRefreshable,
  postFetchRequiresReadonlyMarker,
  noMutationToastInUseFetchCallback,
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
import { createTextReport } from "../../../src/core/index.ts";
import { nitroRulePack, nuxtRulePacks } from "../../../src/rule-packs/nuxt/rules/index.ts";
import {
  htmlButtonHasType,
  preferSameNamePropShorthand,
  preferTrueAttributeShorthand,
} from "../../../src/rule-packs/vue/rules/vue/index.ts";

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

test("nitro/server/no-browser-api reports browser globals used in object shorthand", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInServer,
    framework: "nuxt",
    files: {
      "server/api/user.ts": "export default defineEventHandler(() => ({ window }))",
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["nitro/server/no-browser-api"]);
});

test("nitro/server/no-browser-api reports browser globals used in explicit property values", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInServer,
    framework: "nuxt",
    files: {
      "server/api/user.ts": "export default defineEventHandler(() => ({ value: window }))",
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["nitro/server/no-browser-api"]);
});

test("nitro/server/no-browser-api ignores browser-global names bound by destructuring", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInServer,
    framework: "nuxt",
    files: {
      "server/api/user.ts": "export default defineEventHandler(({ location }) => location)",
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("nuxt/hydration/no-browser-global-in-universal-code reports browser globals used in object shorthand", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": '<script setup lang="ts">const state = { window }</script>',
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "nuxt/hydration/no-browser-global-in-universal-code",
  ]);
});

test("nuxt/hydration/no-browser-global-in-universal-code reports browser globals used in explicit property values", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": '<script setup lang="ts">const state = { value: window }</script>',
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "nuxt/hydration/no-browser-global-in-universal-code",
  ]);
});

test("nuxt/hydration/no-browser-global-in-universal-code ignores browser-global names bound by destructuring", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/pages/index.vue":
        '<script setup lang="ts">const { location } = useRoute(); console.log(location)</script>',
    },
  });

  expect(result.diagnostics).toEqual([]);
});

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

test("async data rules skip files that cannot call async data", () => {
  const rules = [
    asyncDataExplicitKeyForRefreshable,
    asyncDataNoMutationMethods,
    asyncDataHandlerPure,
    noManualActionUseFetch,
    postFetchRequiresReadonlyMarker,
    noMutationToastInUseFetchCallback,
  ];
  const ctx = (text: string) => ({ file: { text }, options: {} }) as any;
  for (const rule of rules) {
    expect(rule.create(ctx(`const data = await $fetch('/api/settings')`))).toBeUndefined();
    for (const text of [
      String.raw`const path = "C:\\temp"; const pattern = /foo\\d+/`,
      String.raw`const value = "\\u0061"`,
      String.raw`const value = "\\x61"`,
      String.raw`const value = "\\141"`,
      `const value = "\\\nother"`,
    ]) {
      expect(rule.create(ctx(text))).toBeUndefined();
    }
    expect(rule.create(ctx(`const { refresh } = useFetch('/api/settings')`))).toBeDefined();
    expect(rule.create(ctx(`const { refresh } = \\u0075seFetch('/api/settings')`))).toBeDefined();
  }
});

test("refreshable async data key rule follows aliased and escaped async data calls", async () => {
  const result = await runRuleFixture({
    rule: asyncDataExplicitKeyForRefreshable,
    framework: "nuxt",
    files: {
      "app/pages/aliased.vue": `<script setup lang="ts">
const load = useFetch
const { refresh } = load('/api/settings')
</script>`,
      "app/pages/escaped.vue": `<script setup lang="ts">
const { refresh } = \\u0075seFetch('/api/settings')
</script>`,
    },
  });

  expect(new Set(result.diagnostics.map((item) => item.file.split("/").pop()))).toEqual(
    new Set(["aliased.vue", "escaped.vue"]),
  );
  expect(result.diagnostics).toHaveLength(2);
});

test.each(["\n", "\r", "\r\n", "\u2028", "\u2029", ""])(
  "refreshable async data preserves escaped computed calls and aliases (%j)",
  async (continuation) => {
    const result = await runRuleFixture({
      rule: asyncDataExplicitKeyForRefreshable,
      framework: "nuxt",
      files: {
        "app/pages/direct.vue": `<script setup lang="ts">
const { refresh } = getApi()["useF\\${continuation}etch"]('/api/settings')
</script>`,
        "app/pages/alias.vue": `<script setup lang="ts">
const load = getApi()["useF\\${continuation}etch"]
const { refresh } = load('/api/settings')
</script>`,
      },
    });
    expect(result.diagnostics).toHaveLength(2);
  },
);

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

  expect(result.diagnostics.map((item) => [item.range?.line, item.severity])).toEqual([
    [12, "warn"],
    [16, "warn"],
  ]);

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
