import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "pathe";
import { expect, test } from "vite-plus/test";
import { createRule, defineDoctorPlugin, runDoctor, vueRulePack } from "../../core/src/index.ts";
import nuxtContentRulePack from "../src/rules/nuxt-content.ts";
import docusRulePack from "../src/rules/docus.ts";
import { preferUButton, preferUFormControls } from "../src/rules/nuxt-ui.ts";
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
} from "../src/rules/nuxt.ts";
import {
  noBrowserApiInServer,
  noClientComposablesInServer,
  preferEventFetch,
  preferAssertMethod,
  preferGetRequestIp,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
  requireEventRuntimeConfigInServer,
} from "../src/rules/nitro/index.ts";
import { runRuleFixture } from "../../core/src/testkit.ts";
import {
  collectNuxtDoctorRulePacks,
  resolveNuxtDoctorMcpOptions,
  writeManifest,
} from "../src/module.ts";
import { mcpToolContracts } from "../src/runtime/mcp/contract.ts";
import { runNuxtDoctorMcpReport } from "../src/runtime/mcp/doctor.ts";
import { createRulesReport, createTextReport, explainRule } from "../../core/src/index.ts";
import { nitroRulePack, nuxtDoctorPlugins, nuxtRulePacks } from "../src/rules/index.ts";
import { createNuxtRuntimeEvidence } from "../src/rules/nuxt/evidence.ts";
import {
  preferUseEventListener,
  preferUseObservers,
  preferUseScrollAndElement,
  preferUseStorage,
  preferUseTimers,
} from "../src/rules/vueuse.ts";

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
    file: "app/composables/useUser.ts",
    source: `export function useUser() { return useAsyncData(() => $fetch('/api/user')) }`,
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
    rule: preferEventFetch,
    id: "nitro/server/prefer-event-fetch",
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

test("app directory placement is only reported for Nuxt 4 projects", async () => {
  const result = await runRuleFixture({
    rule: preferAppDirectoryPlacement,
    framework: "nuxt",
    dependencies: { nuxt: "3.16.2" },
    files: { "pages/index.vue": `<template><div /></template>` },
  });

  expect(result.diagnostics).toHaveLength(0);
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
      "nitro/server/prefer-event-fetch",
      "nitro/runtime/require-event-runtime-config-in-server",
      "nitro/request/prefer-validated-body",
      "nitro/request/prefer-validated-query",
      "nitro/request/prefer-validated-router-params",
      "nitro/request/prefer-assert-method",
      "nitro/request/prefer-get-request-ip",
    ]),
  );
  expect(packs.map((pack) => pack.name)).toContain("nuxt-doctor/nitro");
  expect(
    packs.find((pack) => pack.name === "nuxt-doctor/nuxt")?.rules.map((rule) => rule.meta.id),
  ).not.toContain("nitro/server/prefer-event-fetch");
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

test("Nitro request rules prefer assertMethod for single-method checks", async () => {
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

  expect(result.diagnostics[0]?.ruleId).toBe("nitro/request/prefer-assert-method");
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

test("server fetch public internal routes do not require event context", async () => {
  const result = await runRuleFixture({
    rule: preferEventFetch,
    framework: "nuxt",
    files: {
      "server/api/search.ts": `export default defineEventHandler(() => $fetch('/api/registry/search'))`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("server fetch request-sensitive internal routes require event context", async () => {
  const result = await runRuleFixture({
    rule: preferEventFetch,
    framework: "nuxt",
    files: {
      "server/api/user.ts": `export default defineEventHandler(() => $fetch('/api/user'))`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nitro/server/prefer-event-fetch");
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
        plugins: [defineDoctorPlugin({ name: "vue", rulePacks: [vueRulePack] })],
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
        plugins: [defineDoctorPlugin({ name: "fixture", rulePacks: [] })],
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

test("Nuxt Doctor MCP tools share stable read-only contracts", () => {
  expect(mcpToolContracts.report.name).toBe("doctor_report");
  expect(mcpToolContracts.rules.name).toBe("doctor_rules");
  expect(mcpToolContracts.explainRule.name).toBe("doctor_explain_rule");
  expect(mcpToolContracts.report.annotations.readOnlyHint).toBe(true);
  expect(mcpToolContracts.rules.annotations.readOnlyHint).toBe(true);
  expect(mcpToolContracts.explainRule.annotations.readOnlyHint).toBe(true);
  expect(mcpToolContracts.report.inputSchema.rules).toBeTruthy();
  expect(mcpToolContracts.explainRule.inputSchema.ruleId).toBeTruthy();
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
          ctx.report({
            ruleId: "test/nuxt-runtime-evidence",
            severity: "info",
            category: "architecture",
            file: ctx.file.path,
            range: ctx.range(node),
            message: evidence.executionFor(node),
          });
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
      "nuxt-doctor/nitro",
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
