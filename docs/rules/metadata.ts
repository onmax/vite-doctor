import type { RuleExample } from "./source.js";

export interface RuleDocumentationMetadata {
  description: string;
  why: string;
  recommendedReplacement: string;
  examples: RuleExample[];
}

export const ruleDocumentationMetadata = {
  "docus/appconfig/no-unknown-key": {
    description: "Flags unknown key in Docus appconfig code before it leaks into runtime behavior.",
    why: "Runtime configuration has different server and client visibility. Using the framework API keeps environment data typed and scoped.",
    recommendedReplacement:
      "Remove unknown key, or move it to the Docus runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid unknown key",
        language: "ts",
        invalid:
          "export default defineAppConfig({\n  docus: {},\n  marketing: { enabled: true },\n})",
        valid:
          "export default defineAppConfig({\n  docus: {},\n  ui: { colors: { primary: 'green' } },\n})",
      },
    ],
  },
  "docus/layers/no-empty-app-vue-shadow": {
    description:
      "Flags empty app vue shadow in Docus layers code before it leaks into runtime behavior.",
    why: "Docus gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove empty app vue shadow, or move it to the Docus runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid empty app.vue shadow",
        language: "vue",
        invalid: "<template>\n  <NuxtPage />\n</template>",
        valid: "<template>\n  <DocusLayout>\n    <NuxtPage />\n  </DocusLayout>\n</template>",
      },
    ],
  },
  "nitro/context/no-navigateto-in-nitro": {
    description: "Flags the Nuxt-only navigateTo() helper in Nitro server handlers.",
    why: "navigateTo() belongs to the Nuxt app runtime and is unavailable in Nitro handlers, so the redirect must use the installed H3 generation's response API.",
    recommendedReplacement:
      "Use sendRedirect(event, location) with H3 v1, or return redirect(location) with H3 v2.",
    examples: [
      {
        title: "Avoid navigateTo in Nitro",
        language: "ts",
        invalid: "export default defineEventHandler(() => {\n  return navigateTo('/login')\n})",
        valid: "export default defineHandler(() => {\n  return redirect('/login')\n})",
      },
    ],
  },
  "nitro/context/no-usenuxtapp-in-nitro": {
    description:
      "Flags usenuxtapp in nitro in Nitro context code before it leaks into runtime behavior.",
    why: "Nitro gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove usenuxtapp in nitro, or move it to the Nitro runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid useNuxtApp in Nitro",
        language: "ts",
        invalid:
          "export default defineEventHandler(() => {\n  const nuxtApp = useNuxtApp()\n  return nuxtApp.payload\n})",
        valid:
          "export default defineEventHandler((event) => {\n  return useRuntimeConfig(event).public\n})",
      },
    ],
  },
  "nitro/request/prefer-assert-method": {
    description:
      "Finds Nitro request code that should use the supported assert method pattern instead.",
    why: "Manual method checks can drift from H3 response behavior. assertMethod() applies the framework's method validation and 405 handling consistently.",
    recommendedReplacement: "Use assertMethod(event, method) at the top of single-method handlers.",
    examples: [
      {
        title: "Use assertMethod",
        language: "ts",
        invalid:
          "export default defineEventHandler((event) => {\n  if (getMethod(event) !== 'POST') {\n    throw createError({ statusCode: 405 })\n  }\n})",
        valid: "export default defineEventHandler((event) => {\n  assertMethod(event, 'POST')\n})",
      },
    ],
  },
  "nitro/request/prefer-get-request-ip": {
    description:
      "Finds Nitro request code that should use the supported get request IP pattern instead.",
    why: "Reading x-forwarded-for directly trusts raw proxy input and may return a spoofed or comma-separated value instead of the client address.",
    recommendedReplacement:
      "Use getRequestIP(event) and configure trusted proxy handling centrally.",
    examples: [
      {
        title: "Use getRequestIP",
        language: "ts",
        invalid:
          "export default defineEventHandler((event) => {\n  return getHeader(event, 'x-forwarded-for')\n})",
        valid:
          "export default defineEventHandler((event) => {\n  return getRequestIP(event, { xForwardedFor: true })\n})",
      },
    ],
  },
  "nitro/runtime/require-event-runtime-config-in-server": {
    description: "Checks that Nitro 2 server code passes the request event to useRuntimeConfig().",
    why: "Nitro 2 resolves event-scoped runtime configuration through the handler event, so omitting it can lose request-specific overrides.",
    recommendedReplacement: "Pass the event to useRuntimeConfig(event) in Nitro server handlers.",
    examples: [
      {
        title: "Pass event to runtime config",
        language: "ts",
        invalid:
          "export default defineEventHandler(() => {\n  return useRuntimeConfig().apiSecret\n})",
        valid:
          "export default defineEventHandler((event) => {\n  return useRuntimeConfig(event).apiSecret\n})",
      },
    ],
  },
  "nitro/runtime/no-event-runtime-config-in-server": {
    description: "Checks that Nitro 3 server code calls useRuntimeConfig() without an event.",
    why: "Nitro 3 removed the event-aware signature, so passing the request event keeps code tied to the Nitro 2 API.",
    recommendedReplacement: "Remove the event argument and call useRuntimeConfig().",
    examples: [
      {
        title: "Use the Nitro 3 runtime config signature",
        language: "ts",
        invalid:
          "export default defineHandler((event) => {\n  return useRuntimeConfig(event).apiSecret\n})",
        valid: "export default defineHandler(() => {\n  return useRuntimeConfig().apiSecret\n})",
      },
    ],
  },
  "nitro/migration/no-v2-imports": {
    description: "Flags Nitro 2 package names and public subpaths that Nitro 3 removed.",
    why: "Nitro 3 publishes the nitro package with a smaller export map, so old package names and subpaths fail after the upgrade.",
    recommendedReplacement:
      "Import from nitro and its documented public subpaths. Use nitro/builder for former builder entry points.",
    examples: [
      {
        title: "Use the Nitro 3 package name",
        language: "ts",
        invalid: 'import { defineNitroConfig } from "nitropack/config"',
        valid: 'import { defineConfig } from "nitro"',
      },
    ],
  },
  "nitro/h3/no-removed-send": {
    description: "Flags send() and sendError(), which H3 v2 removes.",
    why: "H3 v2 handlers return Web API response values and throw HTTPError instances instead of using imperative send helpers.",
    recommendedReplacement:
      "Return the response value from the handler, or throw an HTTPError for an error response.",
    examples: [
      {
        title: "Return the response body",
        language: "ts",
        invalid: 'export default defineHandler((event) => {\n  return send(event, "ready")\n})',
        valid: 'export default defineHandler(() => {\n  return "ready"\n})',
      },
    ],
  },
  "nitro/h3/prefer-redirect-response": {
    description: "Flags the H3 v2 sendRedirect compatibility utility.",
    why: "H3 v2 models redirects as returned Web API response values, while sendRedirect remains a compatibility wrapper around the older event-first API.",
    recommendedReplacement:
      "Import redirect and return redirect(location, status) from the handler.",
    examples: [
      {
        title: "Return an H3 v2 redirect",
        language: "ts",
        invalid:
          'export default defineHandler((event) => {\n  return sendRedirect(event, "/login")\n})',
        valid: 'export default defineHandler(() => {\n  return redirect("/login")\n})',
      },
    ],
  },
  "nitro/h3/prefer-with-base": {
    description: "Flags the H3 v2 useBase compatibility alias.",
    why: "H3 v2 renamed the path-prefix handler wrapper to withBase, so using the current name keeps source aligned with the documented API.",
    recommendedReplacement:
      "Import withBase and replace useBase(base, handler) with withBase(base, handler).",
    examples: [
      {
        title: "Use the H3 v2 path-prefix wrapper",
        language: "ts",
        invalid: 'const handler = useBase("/api", app.handler)',
        valid: 'const handler = withBase("/api", app.handler)',
      },
    ],
  },
  "nitro/server/no-browser-api": {
    description: "Flags browser API in Nitro server code before it leaks into runtime behavior.",
    why: "Nitro gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove browser API, or move it to the Nitro runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid browser APIs in server handlers",
        language: "ts",
        invalid: "export default defineEventHandler(() => {\n  return window.location.href\n})",
        valid:
          "export default defineEventHandler((event) => {\n  return getRequestURL(event).href\n})",
      },
    ],
  },
  "nitro/server/no-client-composables": {
    description:
      "Flags client composables in Nitro server code before it leaks into runtime behavior.",
    why: "Nitro gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove client composables, or move it to the Nitro runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid client composables in server handlers",
        language: "ts",
        invalid: "export default defineEventHandler(() => {\n  return useRoute().path\n})",
        valid:
          "export default defineEventHandler((event) => {\n  return getRequestURL(event).pathname\n})",
      },
    ],
  },
  "nuxt-better-auth/require-standard-auth-handler-mount": {
    description:
      "Checks that Nuxt project code includes the standard auth handler mount needed for predictable behavior.",
    why: "Nuxt gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Add standard auth handler mount where Nuxt expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Mount Better Auth handler",
        language: "ts",
        invalid: "// server/api/auth/[...all].ts is missing",
        valid:
          "export default defineEventHandler((event) => {\n  return auth.handler(toWebRequest(event))\n})",
      },
    ],
  },
  "nuxt-content/links/no-broken-internal-to-link": {
    description:
      "Flags broken internal to link in Nuxt links code before it leaks into runtime behavior.",
    why: "Nuxt routing APIs preserve prefetching, SSR behavior, and route state. Raw browser or Vue Router patterns can bypass that integration.",
    recommendedReplacement:
      "Remove broken internal to link, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Fix broken content links",
        language: "md",
        invalid: '::card{to="/missing-page"}\nMissing page\n::',
        valid: '::card{to="/guide/getting-started"}\nGetting started\n::',
      },
    ],
  },
  "nuxt-content/no-querycontent-legacy-api": {
    description:
      "Flags querycontent legacy API in Nuxt project code before it leaks into runtime behavior.",
    why: "Nuxt gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove querycontent legacy API, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use queryCollection",
        language: "ts",
        invalid: "const posts = await queryContent('/blog').find()",
        valid: "const posts = await queryCollection('blog').all()",
      },
    ],
  },
  "nuxt-image/prefer-nuxtimg": {
    description: "Finds Nuxt project code that should use the supported NuxtImg pattern instead.",
    why: "Images affect accessibility, layout stability, and performance. Nuxt Image gives the framework enough information to optimize them.",
    recommendedReplacement: "Use <NuxtImg> with alt text and dimensions for optimized Nuxt images.",
    examples: [
      {
        title: "Use NuxtImg",
        language: "ts",
        invalid: '<template>\n  <img src="/hero.png">\n</template>',
        valid:
          '<template>\n  <NuxtImg src="/hero.png" alt="Hero" width="1200" height="630" />\n</template>',
      },
    ],
  },
  "nuxt-image/prefer-nuxtpicture-for-formats": {
    description:
      "Finds Nuxt project code that should use the supported NuxtPicture for formats pattern instead.",
    why: "Images affect accessibility, layout stability, and performance. Nuxt Image gives the framework enough information to optimize them.",
    recommendedReplacement: "Use <NuxtPicture> when you need format or source-set control.",
    examples: [
      {
        title: "Use NuxtPicture for formats",
        language: "ts",
        invalid: '<template>\n  <img src="/hero.png">\n</template>',
        valid:
          '<template>\n  <NuxtImg src="/hero.png" alt="Hero" width="1200" height="630" />\n</template>',
      },
    ],
  },
  "nuxt-image/prefer-responsive-dimensions": {
    description:
      "Finds Nuxt project code that should use the supported responsive dimensions pattern instead.",
    why: "Images affect accessibility, layout stability, and performance. Nuxt Image gives the framework enough information to optimize them.",
    recommendedReplacement: "Use the Nuxt-supported responsive dimensions pattern instead.",
    examples: [
      {
        title: "Use responsive dimensions",
        language: "ts",
        invalid: '<template>\n  <img src="/hero.png">\n</template>',
        valid:
          '<template>\n  <NuxtImg src="/hero.png" alt="Hero" width="1200" height="630" />\n</template>',
      },
    ],
  },
  "nuxt-image/require-alt": {
    description: "Checks that Nuxt project code includes the alt needed for predictable behavior.",
    why: "Images affect accessibility, layout stability, and performance. Nuxt Image gives the framework enough information to optimize them.",
    recommendedReplacement: "Add meaningful alt text, or an empty alt for decorative images.",
    examples: [
      {
        title: "Add alt",
        language: "ts",
        invalid: '<template>\n  <img src="/hero.png">\n</template>',
        valid:
          '<template>\n  <NuxtImg src="/hero.png" alt="Hero" width="1200" height="630" />\n</template>',
      },
    ],
  },
  "nuxt-scripts/no-raw-third-party-script-tag": {
    description:
      "Flags raw third party script tag in Nuxt project code before it leaks into runtime behavior.",
    why: "Untrusted HTML and scripts are high-risk rendering surfaces. Keep them explicit, constrained, and routed through framework APIs that encode intent.",
    recommendedReplacement:
      "Remove raw third party script tag, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid raw third party script tag",
        language: "ts",
        invalid: "useHead({\n  script: [{ src: 'https://example.com/widget.js' }],\n})",
        valid: "useHeadSafe({\n  script: [{ src: trustedWidgetUrl }],\n})",
      },
    ],
  },
  "nuxt-scripts/no-third-party-config-script": {
    description:
      "Flags third party config script in Nuxt project code before it leaks into runtime behavior.",
    why: "Untrusted HTML and scripts are high-risk rendering surfaces. Keep them explicit, constrained, and routed through framework APIs that encode intent.",
    recommendedReplacement:
      "Remove third party config script, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid third party config script",
        language: "ts",
        invalid: "useHead({\n  script: [{ src: 'https://example.com/widget.js' }],\n})",
        valid: "useHeadSafe({\n  script: [{ src: trustedWidgetUrl }],\n})",
      },
    ],
  },
  "nuxt-scripts/no-third-party-usehead-script": {
    description:
      "Flags third party usehead script in Nuxt project code before it leaks into runtime behavior.",
    why: "Untrusted HTML and scripts are high-risk rendering surfaces. Keep them explicit, constrained, and routed through framework APIs that encode intent.",
    recommendedReplacement:
      "Remove third party usehead script, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid third party usehead script",
        language: "ts",
        invalid: "useHead({\n  script: [{ src: 'https://example.com/widget.js' }],\n})",
        valid: "useHeadSafe({\n  script: [{ src: trustedWidgetUrl }],\n})",
      },
    ],
  },
  "nuxt-ui/prefer-u-button": {
    description: "Finds Nuxt project code that should use the supported u button pattern instead.",
    why: "Native buttons repeat styling, loading, icon, and link behavior that UButton keeps consistent with the project's Nuxt UI theme.",
    recommendedReplacement: "Use the Nuxt-supported u button pattern instead.",
    examples: [
      {
        title: "Use UButton",
        language: "vue",
        invalid: '<template>\n  <button type="button">Save</button>\n</template>',
        valid: '<template>\n  <UButton type="button">Save</UButton>\n</template>',
      },
    ],
  },
  "nuxt-ui/prefer-u-form-controls": {
    description:
      "Finds Nuxt project code that should use the supported u form controls pattern instead.",
    why: "Native form controls bypass Nuxt UI's validation, help text, error state, and accessibility wiring.",
    recommendedReplacement: "Use the Nuxt-supported u form controls pattern instead.",
    examples: [
      {
        title: "Use Nuxt UI form controls",
        language: "vue",
        invalid: '<template>\n  <input v-model="email" type="email">\n</template>',
        valid: '<template>\n  <UInput v-model="email" type="email" />\n</template>',
      },
    ],
  },
  "nuxt-ui/require-uapp-root": {
    description:
      "Checks that Nuxt project code includes the UApp root needed for predictable behavior.",
    why: "Nuxt gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Add UApp root where Nuxt expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Add UApp root",
        language: "vue",
        invalid: "<template>\n  <NuxtPage />\n</template>",
        valid: "<template>\n  <UApp>\n    <NuxtPage />\n  </UApp>\n</template>",
      },
    ],
  },
  "nuxt/async-data-explicit-key-for-refreshable": {
    description:
      "Finds Nuxt project code that can be written with a clearer framework-supported pattern.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Use the Nuxt-supported async data explicit key for refreshable pattern instead.",
    examples: [
      {
        title: "Add explicit refresh key",
        language: "ts",
        invalid: "const { data, refresh } = await useFetch('/api/profile')",
        valid: "const { data, refresh } = await useFetch('/api/profile', {\n  key: 'profile',\n})",
      },
    ],
  },
  "nuxt/async-data-handler-pure": {
    description:
      "Finds Nuxt project code that can be written with a clearer framework-supported pattern.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement: "Use the Nuxt-supported async data handler pure pattern instead.",
    examples: [
      {
        title: "Keep async data handlers pure",
        language: "ts",
        invalid:
          "const { data } = await useAsyncData('orders', async () => {\n  await $fetch('/api/audit', { method: 'POST' })\n  return $fetch('/api/orders')\n})",
        valid:
          "const { data } = await useAsyncData('orders', () => {\n  return $fetch('/api/orders')\n})",
      },
    ],
  },
  "nuxt/async-data-no-mutation-methods": {
    description:
      "Finds Nuxt project code that can be written with a clearer framework-supported pattern.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Use the Nuxt-supported async data no mutation methods pattern instead.",
    examples: [
      {
        title: "Keep mutations out of useFetch",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "async function createOrder() {\n  return await $fetch('/api/orders', {\n    method: 'POST',\n    body: { status: 'draft' },\n  })\n}",
      },
    ],
  },
  "nuxt/composables/no-nested-autoimport-assumption": {
    description:
      "Flags nested autoimport assumption in Nuxt composables code before it leaks into runtime behavior.",
    why: "Auto-imports are global within a project. Explicit names and imports prevent local code from shadowing framework composables.",
    recommendedReplacement:
      "Remove nested autoimport assumption, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Export nested composables explicitly",
        language: "ts",
        invalid:
          "// app/composables/nested/useThing.ts\nexport function useThing() {\n  return useState('thing')\n}",
        valid: "// app/composables/useThing.ts\nexport { useThing } from './nested/useThing'",
      },
    ],
  },
  "nuxt/context/no-composable-after-await": {
    description:
      "Flags composable after await in Nuxt context code before it leaks into runtime behavior.",
    why: "Nuxt gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove composable after await, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Call composables before await",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(async () => {\n  await preloadConfig()\n  const route = useRoute()\n})",
        valid:
          "export default defineNuxtPlugin(async () => {\n  const route = useRoute()\n  await preloadConfig()\n})",
      },
    ],
  },
  "nuxt/context/no-legacy-process-client-server": {
    description: "Flags process.client and process.server under Nuxt compatibility 5.",
    why: "Nuxt compatibility 5 removes the Nuxt type augmentation for process flags, while import.meta.client and import.meta.server remain typed runtime constants.",
    recommendedReplacement: "Use import.meta.client or import.meta.server.",
    examples: [
      {
        title: "Use import.meta client flags",
        language: "ts",
        invalid: "if (process.client) {\n  hydrateChart()\n}",
        valid: "if (import.meta.client) {\n  hydrateChart()\n}",
      },
    ],
  },
  "nuxt/config/no-ignored-compatibility-config": {
    description: "Flags legacy Nuxt settings that compatibility 5 ignores.",
    why: "Nuxt compatibility 5 forces the current head and error-data behavior, so these opt-outs no longer change the runtime.",
    recommendedReplacement:
      "Remove unhead.legacy and experimental.parseErrorData, then update code for the compatibility 5 behavior.",
    examples: [
      {
        title: "Remove ignored compatibility settings",
        language: "ts",
        invalid:
          "export default defineNuxtConfig({\n  unhead: { legacy: true },\n  experimental: { parseErrorData: false },\n})",
        valid: "export default defineNuxtConfig({})",
      },
    ],
  },
  "nuxt/fetch/create-usefetch-must-be-exported-in-scanned-dir": {
    description:
      "Finds Nuxt fetch code that can be written with a clearer framework-supported pattern.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Use the Nuxt-supported create useFetch must be exported in scanned dir pattern instead.",
    examples: [
      {
        title: "Use create useFetch must be exported in scanned dir",
        language: "ts",
        invalid: "const useUser = createUseFetch('/api/user')",
        valid: "export const useUser = createUseFetch('/api/user')",
      },
    ],
  },
  "nuxt/fetch/forward-auth-headers-ssr": {
    description:
      "Finds Nuxt fetch code that can be written with a clearer framework-supported pattern.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement: "Use the Nuxt-supported forward auth headers SSR pattern instead.",
    examples: [
      {
        title: "Forward selected auth headers",
        language: "ts",
        invalid: "const account = await $fetch('/api/account')",
        valid: "const account = await useRequestFetch()('/api/account')",
      },
    ],
  },
  "nuxt/fetch/keyed-composable-registration-required": {
    description:
      "Finds Nuxt fetch code that can be written with a clearer framework-supported pattern.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Use the Nuxt-supported keyed composable registration required pattern instead.",
    examples: [
      {
        title: "Use keyed composable registration required",
        language: "ts",
        invalid:
          "export const useUser = createUseFetch('/api/user')\n\nexport default defineNuxtConfig({})",
        valid:
          "export const useUser = createUseFetch('/api/user')\n\nexport default defineNuxtConfig({\n  optimization: {\n    keyedComposables: [\n      { name: 'useUser', argumentLength: 2 },\n    ],\n  },\n})",
      },
    ],
  },
  "nuxt/fetch/no-await-inside-custom-wrapper": {
    description:
      "Flags await inside custom wrapper in Nuxt fetch code before it leaks into runtime behavior.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Remove await inside custom wrapper, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Return custom async data wrappers directly",
        language: "ts",
        invalid: "export function useUser() {\n  return await useFetch('/api/user')\n}",
        valid: "export function useUser() {\n  return useFetch('/api/user')\n}",
      },
    ],
  },
  "nuxt/fetch/no-raw-fetch-in-setup": {
    description:
      "Flags raw fetch in setup in Nuxt fetch code before it leaks into runtime behavior.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Remove raw fetch in setup, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use Nuxt data fetching in setup",
        language: "vue",
        invalid: "<script setup lang=\"ts\">\nconst data = await $fetch('/api/user')\n</script>",
        valid:
          "<script setup lang=\"ts\">\nconst { data } = await useFetch('/api/user')\n</script>",
      },
    ],
  },
  "nuxt/fetch/prefer-create-use-fetch": {
    description:
      "Finds Nuxt fetch code that should use the supported create use fetch pattern instead.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement: "Use the Nuxt-supported create use fetch pattern instead.",
    examples: [
      {
        title: "Use create use fetch",
        language: "ts",
        invalid: "export function useOrders() {\n  return useFetch('/api/orders')\n}",
        valid: "export const useOrders = createUseFetch('/api/orders')",
      },
    ],
  },
  "nuxt/fetch/require-stable-asyncdata-key": {
    description:
      "Checks that Nuxt fetch code includes the stable useAsyncData key needed for predictable behavior.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Add stable useAsyncData key where Nuxt expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Use stable async data keys",
        language: "ts",
        invalid:
          "const key = Date.now().toString()\nconst { data } = await useAsyncData(key, () => $fetch('/api/user'))",
        valid: "const { data } = await useAsyncData('user', () => $fetch('/api/user'))",
      },
    ],
  },
  "nuxt/hydration/no-browser-global-in-universal-code": {
    description:
      "Flags browser global in universal code in Nuxt hydration code before it leaks into runtime behavior.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Remove browser global in universal code, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid browser globals in universal render",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst width = window.innerWidth\n</script>\n\n<template>{{ width }}</template>',
        valid:
          '<script setup lang="ts">\nconst width = ref<number>()\nonMounted(() => { width.value = window.innerWidth })\n</script>\n\n<template>{{ width }}</template>',
      },
    ],
  },
  "nuxt/hydration/no-browser-side-effects-in-setup": {
    description:
      "Flags browser side effects in setup in Nuxt hydration code before it leaks into runtime behavior.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Remove browser side effects in setup, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Move browser side effects out of setup",
        language: "vue",
        invalid: "<script setup lang=\"ts\">\nlocalStorage.setItem('seen', '1')\n</script>",
        valid:
          "<script setup lang=\"ts\">\nonMounted(() => {\n  localStorage.setItem('seen', '1')\n})\n</script>",
      },
    ],
  },
  "nuxt/hydration/no-client-conditional-in-template": {
    description:
      "Flags client conditional in template in Nuxt hydration code before it leaks into runtime behavior.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Remove client conditional in template, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use ClientOnly for client conditions",
        language: "vue",
        invalid: '<template>\n  <p v-if="import.meta.client">Client only</p>\n</template>',
        valid: "<template>\n  <ClientOnly>\n    <p>Client only</p>\n  </ClientOnly>\n</template>",
      },
    ],
  },
  "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly": {
    description:
      "Flags time-dependent values rendered during SSR before they become hydration mismatches in the browser.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Use <NuxtTime> for SSR-safe date output. Use <ClientOnly> for browser-only timestamps, or use useState() when the first rendered value must stay stable across SSR and hydration.",
    examples: [
      {
        title: "Use NuxtTime for rendered dates",
        language: "vue",
        invalid: "<template>\n  <time>{{ new Date().toLocaleString() }}</time>\n</template>",
        valid: '<template>\n  <NuxtTime :datetime="new Date()" />\n</template>',
      },
      {
        title: "Use ClientOnly for browser-only time",
        language: "vue",
        invalid:
          "<template>\n  <p>Rendered at {{ new Date().toLocaleTimeString() }}</p>\n</template>",
        valid:
          "<template>\n  <ClientOnly>\n    <p>Rendered at {{ new Date().toLocaleTimeString() }}</p>\n  </ClientOnly>\n</template>",
      },
    ],
  },
  "nuxt/hydration/prefer-usecookie-for-initial-client-state": {
    description:
      "Finds Nuxt hydration code that should use the supported usecookie for initial client state pattern instead.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Use the Nuxt-supported usecookie for initial client state pattern instead.",
    examples: [
      {
        title: "Use cookies for initial client state",
        language: "vue",
        invalid:
          "<script setup lang=\"ts\">\nconst theme = ref(localStorage.getItem('theme') || 'light')\n</script>",
        valid:
          "<script setup lang=\"ts\">\nconst theme = useCookie('theme', { default: () => 'light' })\n</script>",
      },
    ],
  },
  "nuxt/imports/no-auto-import-collision": {
    description:
      "Flags auto import collision in Nuxt imports code before it leaks into runtime behavior.",
    why: "Auto-imports are global within a project. Explicit names and imports prevent local code from shadowing framework composables.",
    recommendedReplacement:
      "Remove auto import collision, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid auto-import name collisions",
        language: "ts",
        invalid: "export function useRoute() {\n  return { path: '/custom' }\n}",
        valid: "export function useCustomRoute() {\n  return { path: '/custom' }\n}",
      },
    ],
  },
  "nuxt/imports/no-conflicting-usefetch-import": {
    description:
      "Flags conflicting useFetch import in Nuxt imports code before it leaks into runtime behavior.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Remove conflicting useFetch import, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid conflicting useFetch imports",
        language: "ts",
        invalid:
          "import { useFetch } from '@vueuse/core'\n\nconst { data } = useFetch('/api/user')",
        valid:
          "import { useFetch as useVueUseFetch } from '@vueuse/core'\n\nconst { data } = await useFetch('/api/user')",
      },
    ],
  },
  "nuxt/imports/no-explicit-auto-import": {
    description:
      "Flags value imports that duplicate the auto-imports enabled for the current Nuxt project and file.",
    why: "Nuxt's resolved import registry already accounts for framework APIs, modules, aliases, and scanned app directories. Reusing that registry keeps imports consistent with the project's active configuration.",
    recommendedReplacement:
      "Remove the redundant value import. Keep explicit imports when Nuxt auto-importing is disabled or the file is excluded from transformation.",
    examples: [
      {
        title: "Use configured app utility auto-imports directly",
        language: "ts",
        invalid: "import { formatPrice } from '~/utils/format'\n\nconst label = formatPrice(total)",
        valid: "const label = formatPrice(total)",
      },
    ],
  },
  "nuxt/middleware/no-route-middleware-api-security": {
    description:
      "Flags route middleware API security in Nuxt middleware code before it leaks into runtime behavior.",
    why: "Navigation helpers only work correctly in the runtime they were designed for. Returning the navigation result keeps redirects and aborts observable to Nuxt.",
    recommendedReplacement:
      "Remove route middleware API security, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Keep API authorization on the server",
        language: "ts",
        invalid:
          "export default defineNuxtRouteMiddleware((to) => {\n  if (!to.query.token) return abortNavigation()\n})",
        valid:
          "export default defineEventHandler((event) => {\n  const token = getQuery(event).token\n  if (!token) throw createError({ statusCode: 401 })\n})",
      },
    ],
  },
  "nuxt/no-global-refresh-without-justification": {
    description:
      "Flags global refresh without justification in Nuxt project code before it leaks into runtime behavior.",
    why: "Refreshing every async-data key refetches unrelated state and hides which data a mutation actually invalidates.",
    recommendedReplacement:
      "Remove global refresh without justification, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Refresh specific async data keys",
        language: "ts",
        invalid: "await refreshNuxtData()",
        valid: "await refreshNuxtData('orders')",
      },
    ],
  },
  "nuxt/no-manual-action-usefetch": {
    description:
      "Flags manual action useFetch in Nuxt project code before it leaks into runtime behavior.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Remove manual action useFetch, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use $fetch for manual mutations",
        language: "ts",
        invalid:
          "const { execute } = await useFetch('/api/orders', {\n  method: 'POST',\n  immediate: false,\n})",
        valid:
          "async function submitOrder() {\n  await $fetch('/api/orders', { method: 'POST' })\n}",
      },
    ],
  },
  "nuxt/no-mutation-toast-in-usefetch-callback": {
    description:
      "Flags mutation toast in useFetch callback in Nuxt project code before it leaks into runtime behavior.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Remove mutation toast in useFetch callback, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Move callback effects into actions",
        language: "ts",
        invalid:
          "await useFetch('/api/orders', {\n  method: 'POST',\n  onResponse() {\n    toast.add({ title: 'Saved' })\n  },\n})",
        valid:
          "async function saveOrder() {\n  await $fetch('/api/orders', { method: 'POST' })\n  toast.add({ title: 'Saved' })\n}",
      },
    ],
  },
  "nuxt/plugins/no-subdir-auto-registration-assumption": {
    description:
      "Flags subdir auto registration assumption in Nuxt plugins code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove subdir auto registration assumption, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Register nested plugins explicitly",
        language: "ts",
        invalid: "// app/plugins/nested/analytics.ts\nexport default defineNuxtPlugin(() => {})",
        valid:
          "export default defineNuxtConfig({\n  plugins: ['~/app/plugins/nested/analytics'],\n})",
      },
    ],
  },
  "nuxt/post-fetch-requires-readonly-marker": {
    description: "Finds write-like POST Nuxt async-data requests that can replay.",
    why: "Nuxt async data can be replayed by refreshes, hydration, and watch sources. Write-like POST endpoints should not be registered as replayable data.",
    recommendedReplacement:
      "Move writes to $fetch() event handlers. Read-like POST query endpoints are ignored by default; configure readonlyPaths for read-only endpoints that look write-like.",
    examples: [
      {
        title: "Move write-like POST work out of async data",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/jobs/trigger', {\n  method: 'POST',\n  body,\n})",
        valid:
          "async function triggerJob() {\n  await $fetch('/api/jobs/trigger', {\n    method: 'POST',\n    body,\n  })\n}",
      },
    ],
  },
  "nuxt/preview-mode-global-refresh": {
    description:
      "Finds Nuxt project code that can be written with a clearer framework-supported pattern.",
    why: "usePreviewMode() can refresh every async-data key when preview state changes, including requests unrelated to preview content.",
    recommendedReplacement: "Use the Nuxt-supported preview mode global refresh pattern instead.",
    examples: [
      {
        title: "Refresh preview data by key",
        language: "ts",
        invalid: "if (preview.value) {\n  await refreshNuxtData()\n}",
        valid: "if (preview.value) {\n  await refreshNuxtData('preview-posts')\n}",
      },
    ],
  },
  "nuxt/project/prefer-app-directory-placement": {
    description:
      "Finds Nuxt project code that should use the supported app directory placement pattern instead.",
    why: "Nuxt 4 scans app code under app/. Keeping legacy top-level directories can make ownership unclear and diverge from the current directory contract.",
    recommendedReplacement: "Use the Nuxt-supported app directory placement pattern instead.",
    examples: [
      {
        title: "Place app files in app directory",
        language: "text",
        invalid: "pages/index.vue\ncomponents/AppHeader.vue",
        valid: "app/pages/index.vue\napp/components/AppHeader.vue",
      },
    ],
  },
  "nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup": {
    description:
      "Flags hash sensitive route fullpath in SSR markup in Nuxt routing code before it leaks into runtime behavior.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Remove hash sensitive route fullpath in SSR markup, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid fullPath in SSR markup",
        language: "vue",
        invalid: "<template>\n  <p>{{ useRoute().fullPath }}</p>\n</template>",
        valid:
          '<script setup lang="ts">\nconst route = useRoute()\n</script>\n\n<template>\n  <p>{{ route.path }}</p>\n</template>',
      },
    ],
  },
  "nuxt/routing/no-route-object-page-key": {
    description:
      "Flags route object page key in Nuxt routing code before it leaks into runtime behavior.",
    why: "Nuxt routing APIs preserve prefetching, SSR behavior, and route state. Raw browser or Vue Router patterns can bypass that integration.",
    recommendedReplacement:
      "Remove route object page key, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use scalar page keys",
        language: "vue",
        invalid:
          '<script setup lang="ts">\ndefinePageMeta({\n  key: route => route,\n})\n</script>',
        valid:
          '<script setup lang="ts">\ndefinePageMeta({\n  key: route => route.fullPath,\n})\n</script>',
      },
    ],
  },
  "nuxt/routing/no-router-navigation-in-setup": {
    description:
      "Flags router navigation in setup in Nuxt routing code before it leaks into runtime behavior.",
    why: "Navigation helpers only work correctly in the runtime they were designed for. Returning the navigation result keeps redirects and aborts observable to Nuxt.",
    recommendedReplacement:
      "Remove router navigation in setup, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Move navigation out of setup render",
        language: "vue",
        invalid:
          "<script setup lang=\"ts\">\nconst router = useRouter()\nrouter.push('/login')\n</script>",
        valid:
          "<script setup lang=\"ts\">\nconst router = useRouter()\nfunction goToLogin() {\n  return router.push('/login')\n}\n</script>",
      },
    ],
  },
  "nuxt/routing/no-useroute-in-middleware": {
    description:
      "Flags useRoute in middleware in Nuxt routing code before it leaks into runtime behavior.",
    why: "Navigation helpers only work correctly in the runtime they were designed for. Returning the navigation result keeps redirects and aborts observable to Nuxt.",
    recommendedReplacement:
      "Remove useRoute in middleware, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use middleware arguments",
        language: "ts",
        invalid:
          "export default defineNuxtRouteMiddleware(() => {\n  const route = useRoute()\n  if (!route.meta.auth) return\n})",
        valid:
          "export default defineNuxtRouteMiddleware((to) => {\n  if (!to.meta.auth) return\n})",
      },
    ],
  },
  "nuxt/routing/prefer-nuxt-useroute": {
    description:
      "Finds Nuxt routing code that should use the supported nuxt useRoute pattern instead.",
    why: "Nuxt's useRoute() wrapper synchronizes route updates with page rendering; the vue-router version can expose route state at a different time.",
    recommendedReplacement: "Use Nuxt’s auto-imported useRoute() inside Nuxt app code.",
    examples: [
      {
        title: "Use Nuxt useRoute",
        language: "ts",
        invalid: "import { useRoute } from 'vue-router'\n\nconst route = useRoute()",
        valid: "const route = useRoute()",
      },
    ],
  },
  "nuxt/routing/prefer-nuxtlink": {
    description: "Finds Nuxt routing code that should use the supported NuxtLink pattern instead.",
    why: "NuxtLink handles client navigation, route prefetching, base paths, and external-link behavior for Nuxt applications.",
    recommendedReplacement: "Use <NuxtLink> for internal navigation.",
    examples: [
      {
        title: "Use NuxtLink",
        language: "ts",
        invalid: '<template>\n  <a href="/dashboard">Dashboard</a>\n</template>',
        valid: '<template>\n  <NuxtLink to="/dashboard">Dashboard</NuxtLink>\n</template>',
      },
    ],
  },
  "nuxt/routing/prefer-nuxtpage-over-routerview": {
    description:
      "Finds Nuxt routing code that should use the supported NuxtPage over routerview pattern instead.",
    why: "NuxtPage connects routed views to Nuxt page metadata, transitions, keep-alive behavior, and Suspense handling.",
    recommendedReplacement: "Render routed pages with <NuxtPage>.",
    examples: [
      {
        title: "Use NuxtPage over routerview",
        language: "ts",
        invalid: "<template>\n  <RouterView />\n</template>",
        valid: "<template>\n  <NuxtPage />\n</template>",
      },
    ],
  },
  "nuxt/routing/return-navigateto-in-middleware": {
    description:
      "Finds Nuxt routing code that calls navigateto in middleware without returning the result.",
    why: "Navigation helpers only work correctly in the runtime they were designed for. Returning the navigation result keeps redirects and aborts observable to Nuxt.",
    recommendedReplacement:
      "Return navigateTo() from route middleware so Nuxt can apply the redirect.",
    examples: [
      {
        title: "Return navigateTo",
        language: "ts",
        invalid: "export default defineNuxtRouteMiddleware(() => {\n  navigateTo('/login')\n})",
        valid:
          "export default defineNuxtRouteMiddleware(() => {\n  return navigateTo('/login')\n})",
      },
    ],
  },
  "nuxt/runtime/no-plain-env-in-app-code": {
    description:
      "Flags plain env in app code in Nuxt runtime code before it leaks into runtime behavior.",
    why: "Runtime configuration has different server and client visibility. Using the framework API keeps environment data typed and scoped.",
    recommendedReplacement:
      "Read configuration through useRuntimeConfig() instead of process.env in app code.",
    examples: [
      {
        title: "Use runtime config in app code",
        language: "ts",
        invalid: "const apiBase = process.env.NUXT_PUBLIC_API_BASE",
        valid: "const apiBase = useRuntimeConfig().public.apiBase",
      },
    ],
  },
  "nuxt/runtime/no-secret-in-public-config": {
    description:
      "Flags secret in public config in Nuxt runtime code before it leaks into runtime behavior.",
    why: "Secrets that reach public runtime config or client bundles can be exposed to every visitor and crawler.",
    recommendedReplacement:
      "Move secrets to private runtimeConfig and read them only on the server.",
    examples: [
      {
        title: "Avoid secret in public config",
        language: "ts",
        invalid:
          "export default defineNuxtConfig({\n  runtimeConfig: {\n    public: { apiSecret: process.env.API_SECRET },\n  },\n})",
        valid:
          "export default defineNuxtConfig({\n  runtimeConfig: {\n    apiSecret: process.env.API_SECRET,\n    public: { apiBase: '/api' },\n  },\n})",
      },
    ],
  },
  "nuxt/security/no-unsafe-usehead-script": {
    description:
      "Flags unsafe usehead script in Nuxt security code before it leaks into runtime behavior.",
    why: "Untrusted HTML and scripts are high-risk rendering surfaces. Keep them explicit, constrained, and routed through framework APIs that encode intent.",
    recommendedReplacement:
      "Remove unsafe usehead script, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid unsafe usehead script",
        language: "ts",
        invalid: "useHead({\n  script: [{ src: 'https://example.com/widget.js' }],\n})",
        valid: "useHeadSafe({\n  script: [{ src: trustedWidgetUrl }],\n})",
      },
    ],
  },
  "nuxt/security/prefer-useheadsafe-for-untrusted-values": {
    description:
      "Finds Nuxt security code that should use the supported useheadsafe for untrusted values pattern instead.",
    why: "Values derived from routes, content, or users can inject unsafe head attributes when passed through unrestricted useHead().",
    recommendedReplacement:
      "Use the Nuxt-supported useheadsafe for untrusted values pattern instead.",
    examples: [
      {
        title: "Use useHeadSafe for untrusted values",
        language: "ts",
        invalid: "const route = useRoute()\nuseHead({\n  title: route.query.title as string,\n})",
        valid: "const route = useRoute()\nuseHeadSafe({\n  title: route.query.title as string,\n})",
      },
    ],
  },
  "nuxt/seo/prefer-seo-composables": {
    description:
      "Finds Nuxt seo code that should use the supported seo composables pattern instead.",
    why: "useSeoMeta() provides typed, flat SEO fields and prevents malformed name, property, and content combinations in manual head arrays.",
    recommendedReplacement: "Use the Nuxt-supported seo composables pattern instead.",
    examples: [
      {
        title: "Use SEO composables",
        language: "ts",
        invalid:
          "useHead({\n  title: 'Home',\n  meta: [{ name: 'description', content: 'Welcome' }],\n})",
        valid: "useSeoMeta({\n  title: 'Home',\n  description: 'Welcome',\n})",
      },
    ],
  },
  "nuxt/shared/no-nested-shared-autoimport-assumption": {
    description:
      "Flags nested shared autoimport assumption in Nuxt shared code before it leaks into runtime behavior.",
    why: "Auto-imports are global within a project. Explicit names and imports prevent local code from shadowing framework composables.",
    recommendedReplacement:
      "Remove nested shared autoimport assumption, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Export nested shared utilities explicitly",
        language: "ts",
        invalid:
          "// shared/utils/nested/math.ts\nexport const add = (a: number, b: number) => a + b",
        valid: "// shared/utils/math.ts\nexport { add } from './nested/math'",
      },
    ],
  },
  "nuxt/shared/no-vue-or-nitro-context-in-shared": {
    description:
      "Flags vue or nitro context in shared in Nuxt shared code before it leaks into runtime behavior.",
    why: "Nuxt gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove vue or nitro context in shared, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Keep shared utilities runtime-neutral",
        language: "ts",
        invalid: "export function currentPath() {\n  return useRoute().path\n}",
        valid: "export function currentPath(path: string) {\n  return path\n}",
      },
    ],
  },
  "nuxt/state/no-nonserializable-usestate": {
    description:
      "Flags nonserializable usestate in Nuxt state code before it leaks into runtime behavior.",
    why: "Nuxt transfers useState() values through the SSR payload, so functions, class instances, DOM objects, and other non-serializable values cannot hydrate reliably.",
    recommendedReplacement:
      "Remove nonserializable usestate, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Keep useState serializable",
        language: "ts",
        invalid: "const socket = useState('socket', () => new WebSocket('wss://example.com'))",
        valid: "const socketUrl = useState('socket-url', () => 'wss://example.com')",
      },
    ],
  },
  "nuxt/state/prefer-explicit-usestate-key-in-exported-composables": {
    description:
      "Finds Nuxt state code that should use the supported explicit usestate key in exported composables pattern instead.",
    why: "Compiler-generated useState() keys depend on the composable's source location. An explicit key keeps state identity stable when an exported composable moves or changes.",
    recommendedReplacement:
      "Use the Nuxt-supported explicit usestate key in exported composables pattern instead.",
    examples: [
      {
        title: "Use explicit useState keys",
        language: "ts",
        invalid: "export function useCounter() {\n  return useState(() => 0)\n}",
        valid: "export function useCounter() {\n  return useState('counter', () => 0)\n}",
      },
    ],
  },
  "nuxthub/no-personalized-cached-handler": {
    description:
      "Flags personalized cached handler in Nuxthub project code before it leaks into runtime behavior.",
    why: "Cached server responses are shared beyond one request. Personalized data in a shared cache can leak state or serve stale content.",
    recommendedReplacement:
      "Remove personalized cached handler, or move it to the Nuxthub runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid personalized cached handlers",
        language: "ts",
        invalid:
          "export default cachedEventHandler(async (event) => {\n  const session = await getUserSession(event)\n  return session.user\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const session = await getUserSession(event)\n  return session.user\n})",
      },
    ],
  },
  "nuxthub/prefer-cached-event-handler": {
    description:
      "Finds Nuxthub project code that should use the supported cached event handler pattern instead.",
    why: "Cached server responses are shared beyond one request. Personalized data in a shared cache can leak state or serve stale content.",
    recommendedReplacement: "Use the Nuxthub-supported cached event handler pattern instead.",
    examples: [
      {
        title: "Cache public expensive handlers",
        language: "ts",
        invalid:
          "export default defineEventHandler(async () => {\n  return await queryCollection('docs').all()\n})",
        valid:
          "export default cachedEventHandler(async () => {\n  return await queryCollection('docs').all()\n})",
      },
    ],
  },
  "vite/assets/no-dynamic-new-url": {
    description: "Flags dynamic new URL in Vite assets code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove dynamic new URL, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use static asset URLs",
        language: "ts",
        invalid: "const icon = new URL(`./icons/${name}.svg`, import.meta.url).href",
        valid:
          "const icons = {\n  home: new URL('./icons/home.svg', import.meta.url).href,\n}\nconst icon = icons.home",
      },
    ],
  },
  "vite/assets/no-public-src-import": {
    description:
      "Flags public media and font imports in Vite code before they bypass the intended public URL contract.",
    why: "Files in public are copied as-is and served from the root URL. Import image, font, and media assets from source when they need bundling, or reference public assets by URL when they should stay static. Static JSON data imports are allowed because SSR pages may need build-time data instead of a runtime fetch.",
    recommendedReplacement:
      "Reference public media and font assets by root-relative URL, or move bundled assets into source.",
    examples: [
      {
        title: "Reference public assets by URL",
        language: "ts",
        invalid: "import logoUrl from '../public/logo.svg'",
        valid: "const logoUrl = '/logo.svg'",
      },
    ],
  },
  "vite/assets/no-src-absolute-public-url": {
    description:
      "Flags src absolute public URL in Vite assets code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove src absolute public URL, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Import src assets",
        language: "vue",
        invalid: '<template>\n  <img src="/src/assets/logo.svg" alt="Logo">\n</template>',
        valid:
          '<script setup lang="ts">\nimport logoUrl from \'~/assets/logo.svg\'\n</script>\n\n<template>\n  <img :src="logoUrl" alt="Logo">\n</template>',
      },
    ],
  },
  "vite/define/no-runtime-object-define": {
    description:
      "Flags runtime object define in Vite define code before it leaks into runtime behavior.",
    why: "Runtime configuration has different server and client visibility. Using the framework API keeps environment data typed and scoped.",
    recommendedReplacement:
      "Remove runtime object define, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid runtime object define",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vite/define/no-secret-define": {
    description: "Flags secret define in Vite define code before it leaks into runtime behavior.",
    why: "Secrets that reach public runtime config or client bundles can be exposed to every visitor and crawler.",
    recommendedReplacement:
      "Remove secret define, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Keep secrets out of define",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __API_SECRET__: JSON.stringify(process.env.API_SECRET),\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __PUBLIC_VERSION__: JSON.stringify(process.env.npm_package_version),\n  },\n})",
      },
    ],
  },
  "vite/define/no-untyped-define": {
    description: "Flags untyped define in Vite define code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove untyped define, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Declare define constants",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __FEATURE_FLAG__: JSON.stringify(true),\n  },\n})",
        valid:
          "declare const __FEATURE_FLAG__: boolean\n\nexport default defineConfig({\n  define: {\n    __FEATURE_FLAG__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vite/define/no-unused-define": {
    description: "Flags unused define in Vite define code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove unused define, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Remove unused define constants",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __UNUSED_FLAG__: JSON.stringify(true),\n  },\n})",
        valid: "export default defineConfig({\n  define: {},\n})",
      },
    ],
  },
  "vite/env/no-broad-env-prefix": {
    description: "Flags broad env prefix in Vite env code before it leaks into runtime behavior.",
    why: "Every matching prefix exposes environment variables to client code through import.meta.env, so broad prefixes can publish unrelated configuration.",
    recommendedReplacement:
      "Remove broad env prefix, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use narrow env prefixes",
        language: "ts",
        invalid: "export default defineConfig({\n  envPrefix: ['VITE_', 'APP_'],\n})",
        valid: "export default defineConfig({\n  envPrefix: ['VITE_PUBLIC_'],\n})",
      },
    ],
  },
  "vite/env/no-client-secret-pattern": {
    description:
      "Flags client secret pattern in Vite env code before it leaks into runtime behavior.",
    why: "Secrets that reach public runtime config or client bundles can be exposed to every visitor and crawler.",
    recommendedReplacement:
      "Remove client secret pattern, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Keep secret env vars server-only",
        language: "ts",
        invalid: "const token = import.meta.env.VITE_API_SECRET",
        valid: "const apiBase = import.meta.env.VITE_PUBLIC_API_BASE",
      },
    ],
  },
  "vite/env/no-empty-env-prefix": {
    description: "Flags empty env prefix in Vite env code before it leaks into runtime behavior.",
    why: "Vite rejects an empty envPrefix to prevent exposing every environment variable to bundled client code, including secrets.",
    recommendedReplacement:
      "Remove empty env prefix, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Do not expose every env var",
        language: "ts",
        invalid: "export default defineConfig({\n  envPrefix: '',\n})",
        valid: "export default defineConfig({\n  envPrefix: 'VITE_',\n})",
      },
    ],
  },
  "vite/env/no-untyped-env": {
    description: "Flags untyped env in Vite env code before it leaks into runtime behavior.",
    why: "Runtime configuration has different server and client visibility. Using the framework API keeps environment data typed and scoped.",
    recommendedReplacement:
      "Remove untyped env, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Type import.meta.env access",
        language: "ts",
        invalid: "const apiBase = import.meta.env.VITE_API_BASE",
        valid:
          "interface ImportMetaEnv {\n  readonly VITE_API_BASE: string\n}\n\nconst apiBase = import.meta.env.VITE_API_BASE",
      },
    ],
  },
  "vite/env/prefer-direct-import-meta-env-access": {
    description:
      "Finds Vite env code that should use the supported direct import meta env access pattern instead.",
    why: "Direct import.meta.env.KEY access lets Vite statically replace known values and tree-shake branches; aliasing the whole object obscures those keys.",
    recommendedReplacement: "Use the Vite-supported direct import meta env access pattern instead.",
    examples: [
      {
        title: "Use direct env access",
        language: "ts",
        invalid: "const env = import.meta.env\nconst apiBase = env.VITE_API_BASE",
        valid: "const apiBase = import.meta.env.VITE_API_BASE",
      },
    ],
  },
  "vite/hmr/require-dispose-for-side-effects": {
    description:
      "Checks that Vite hmr code includes the dispose for side effects needed for predictable behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Add dispose for side effects where Vite expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Dispose HMR side effects",
        language: "ts",
        invalid:
          "const timer = setInterval(sync, 1000)\n\nif (import.meta.hot) {\n  import.meta.hot.accept()\n}",
        valid:
          "const timer = setInterval(sync, 1000)\n\nif (import.meta.hot) {\n  import.meta.hot.dispose(() => clearInterval(timer))\n}",
      },
    ],
  },
  "vite/plugin/prefer-transform-filter": {
    description:
      "Finds Vite plugin code that should use the supported transform filter pattern instead.",
    why: "A hook filter lets Vite and Rolldown skip invoking transform() for unrelated modules instead of paying for a userland check on every file.",
    recommendedReplacement: "Use the Vite-supported transform filter pattern instead.",
    examples: [
      {
        title: "Filter plugin transforms",
        language: "ts",
        invalid:
          "export default function markdownPlugin() {\n  return {\n    name: 'markdown',\n    transform(code, id) {\n      if (!id.endsWith('.md')) return\n      return code\n    },\n  }\n}",
        valid:
          "export default function markdownPlugin() {\n  return {\n    name: 'markdown',\n    transform: {\n      filter: { id: /\\.md$/ },\n      handler(code) { return code },\n    },\n  }\n}",
      },
    ],
  },
  "vite/plugin/require-name": {
    description: "Checks that Vite plugin code includes the name needed for predictable behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement: "Add name where Vite expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Name Vite plugins",
        language: "ts",
        invalid:
          "export default function plugin() {\n  return {\n    transform(code) { return code },\n  }\n}",
        valid:
          "export default function plugin() {\n  return {\n    name: 'app-plugin',\n    transform(code) { return code },\n  }\n}",
      },
    ],
  },
  "vite/server/no-broad-fs-allow": {
    description: "Flags broad fs allow in Vite server code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove broad fs allow, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Limit server.fs.allow",
        language: "ts",
        invalid: "export default defineConfig({\n  server: {\n    fs: { allow: ['..'] },\n  },\n})",
        valid:
          "export default defineConfig({\n  server: {\n    fs: { allow: ['packages/ui'] },\n  },\n})",
      },
    ],
  },
  "vite/server/no-disabled-fs-strict": {
    description:
      "Flags disabled fs strict in Vite server code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove disabled fs strict, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Keep fs strict enabled",
        language: "ts",
        invalid: "export default defineConfig({\n  server: {\n    fs: { strict: false },\n  },\n})",
        valid: "export default defineConfig({\n  server: {\n    fs: { strict: true },\n  },\n})",
      },
    ],
  },
  "vite/ssr/no-browser-global-in-ssr-entry": {
    description:
      "Flags browser global in SSR entry in Vite SSR code before it leaks into runtime behavior.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Remove browser global in SSR entry, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid browser globals in SSR entry",
        language: "ts",
        invalid: "export function render() {\n  return window.location.href\n}",
        valid: "export function render(url: string) {\n  return url\n}",
      },
    ],
  },
  "vite/worker/no-dynamic-worker-url": {
    description:
      "Flags dynamic worker URL in Vite worker code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove dynamic worker URL, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use static worker URLs",
        language: "ts",
        invalid: "const worker = new Worker(new URL(`./workers/${name}.ts`, import.meta.url))",
        valid:
          "const worker = new Worker(new URL('./workers/sync.ts', import.meta.url), { type: 'module' })",
      },
    ],
  },
  "vite/worker/no-node-api-in-worker": {
    description:
      "Flags node API in worker in Vite worker code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove node API in worker, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid Node APIs in workers",
        language: "ts",
        invalid:
          "import { readFileSync } from 'node:fs'\n\nself.postMessage(readFileSync('data.txt', 'utf8'))",
        valid: "self.postMessage(await fetch('/data.txt').then(r => r.text()))",
      },
    ],
  },
  "vite/worker/require-worker-url-pattern": {
    description:
      "Checks that Vite worker code includes the worker URL pattern needed for predictable behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Add worker URL pattern where Vite expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Use Vite worker URL pattern",
        language: "ts",
        invalid: "const worker = new Worker('./worker.ts')",
        valid:
          "const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })",
      },
    ],
  },
  "vue/i18n/no-untranslated-text": {
    description: "Flags untranslated text in Vue i18n code before it leaks into runtime behavior.",
    why: "Vue gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove untranslated text, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Use translation keys",
        language: "vue",
        invalid: "<template>\n  <p>Welcome back</p>\n</template>",
        valid: "<template>\n  <p>{{ t('welcomeBack') }}</p>\n</template>",
      },
    ],
  },
  "vue/i18n/no-unused-translations": {
    description:
      "Flags unused translations in Vue i18n code before it leaks into runtime behavior.",
    why: "Vue gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove unused translations, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Remove unused translations",
        language: "json",
        invalid: '{\n  "used": "Save",\n  "unused": "Delete"\n}',
        valid: '{\n  "used": "Save"\n}',
      },
    ],
  },
  "vue/lifecycle/no-mutation-in-onupdated": {
    description:
      "Flags mutation in onupdated in Vue lifecycle code before it leaks into runtime behavior.",
    why: "onUpdated runs after any DOM update caused by reactive state. Mutating reactive component state there can schedule another update and create an update loop.",
    recommendedReplacement:
      "Do not write to reactive values in onUpdated. Move the state change to the event or state transition that owns it, or use non-reactive local state for bookkeeping that does not drive rendering.",
    examples: [
      {
        title: "Use non-reactive bookkeeping",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst updateCount = ref(0)\nonUpdated(() => {\n  updateCount.value++\n})\n</script>',
        valid:
          '<script setup lang="ts">\nlet updateCount = 0\nonUpdated(() => {\n  updateCount++\n})\n</script>',
      },
      {
        title: "Move reactive writes to the owner",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst count = ref(0)\nonUpdated(() => {\n  count.value++\n})\n</script>',
        valid:
          '<script setup lang="ts">\nconst count = ref(0)\n\nfunction increment() {\n  count.value++\n}\n</script>\n\n<template>\n  <button type="button" @click="increment">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/lifecycle/require-cleanup": {
    description:
      "Checks that Vue lifecycle code includes the cleanup needed for predictable behavior.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement:
      "Add cleanup where Vue expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Clean up lifecycle side effects",
        language: "vue",
        invalid:
          "<script setup lang=\"ts\">\nonMounted(() => {\n  window.addEventListener('resize', onResize)\n})\n</script>",
        valid:
          "<script setup lang=\"ts\">\nonMounted(() => {\n  window.addEventListener('resize', onResize)\n})\nonBeforeUnmount(() => {\n  window.removeEventListener('resize', onResize)\n})\n</script>",
      },
    ],
  },
  "vue/lifecycle/prefer-use-event-listener": {
    description:
      "Finds Vue scopes that manually pair DOM event listener setup and cleanup when VueUse is already available.",
    why: "DOM listeners are lifecycle resources. Keeping setup and disposal behind a composable makes repeated watcher runs, component unmounts, and composable scope disposal harder to drift apart.",
    recommendedReplacement:
      "Use VueUse useEventListener() for DOM listeners. In watcher callbacks, keep the returned stop handle in watcher cleanup when each watcher run owns a fresh listener.",
    examples: [
      {
        title: "Use VueUse for watcher-owned listeners",
        language: "ts",
        invalid:
          "watch(active, (_value, _oldValue, onCleanup) => {\n  const el = document.querySelector('.target')\n  if (!el) return\n  const onEnd = () => el.classList.remove('active')\n  el.addEventListener('animationend', onEnd, { once: true })\n  onCleanup(() => el.removeEventListener('animationend', onEnd))\n})",
        valid:
          "watch(active, (_value, _oldValue, onCleanup) => {\n  const el = document.querySelector('.target')\n  if (!el) return\n  const stop = useEventListener(el, 'animationend', () => {\n    el.classList.remove('active')\n  }, { once: true })\n  onCleanup(stop)\n})",
      },
    ],
  },
  "vue/reactivity/defineprops-watch-getter": {
    description:
      "Finds Vue reactivity code that can be written with a clearer framework-supported pattern.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement: "Use the Vue-supported defineProps watch getter pattern instead.",
    examples: [
      {
        title: "Watch props with getters",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ id: string }>()\nwatch(props.id, loadUser)\n</script>',
        valid:
          '<script setup lang="ts">\nconst props = defineProps<{ id: string }>()\nwatch(() => props.id, loadUser)\n</script>',
      },
    ],
  },
  "vue/reactivity/no-ref-as-operand": {
    description:
      "Flags ref as operand in Vue reactivity code before it leaks into runtime behavior.",
    why: "A ref object is not its contained value, so arithmetic and comparison against the ref can coerce the wrapper or produce the wrong result.",
    recommendedReplacement:
      "Remove ref as operand, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Read ref values before arithmetic",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst count = ref(1)\nconst next = count + 1\n</script>',
        valid:
          '<script setup lang="ts">\nconst count = ref(1)\nconst next = count.value + 1\n</script>',
      },
    ],
  },
  "vue/reactivity/no-setup-props-destructure": {
    description:
      "Flags setup props destructure in Vue reactivity code before it leaks into runtime behavior.",
    why: "Destructuring the props object in setup can detach values from their reactive source when the code cannot rely on Vue's reactive props transform.",
    recommendedReplacement:
      "Remove setup props destructure, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Preserve prop reactivity",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst { count } = defineProps<{ count: number }>()\n</script>',
        valid:
          "<script setup lang=\"ts\">\nconst props = defineProps<{ count: number }>()\nconst count = toRef(props, 'count')\n</script>",
      },
    ],
  },
  "vue/reactivity/prefer-composable-ref-return": {
    description:
      "Finds Vue reactivity code that should use the supported composable ref return pattern instead.",
    why: "Returning ref.value gives callers a snapshot; returning the ref preserves updates and lets callers compose it with Vue reactivity.",
    recommendedReplacement: "Use the Vue-supported composable ref return pattern instead.",
    examples: [
      {
        title: "Return refs from composables",
        language: "ts",
        invalid: "export function useCounter() {\n  const count = ref(0)\n  return count.value\n}",
        valid: "export function useCounter() {\n  const count = ref(0)\n  return count\n}",
      },
    ],
  },
  "vue/security/restrict-v-html": {
    description: "Flags risky v HTML usage in Vue security code.",
    why: "Untrusted HTML and scripts are high-risk rendering surfaces. Keep them explicit, constrained, and routed through framework APIs that encode intent.",
    recommendedReplacement: "Keep v HTML behind the safest Vue API available for that surface.",
    examples: [
      {
        title: "Sanitize v-html input",
        language: "vue",
        invalid: '<template>\n  <div v-html="comment.body" />\n</template>',
        valid: '<template>\n  <div v-html="sanitizeHtml(comment.body)" />\n</template>',
      },
    ],
  },
  "vue/ssr/data-allow-mismatch-surgical": {
    description:
      "Finds Vue SSR code that can be written with a clearer framework-supported pattern.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement: "Use the Vue-supported data allow mismatch surgical pattern instead.",
    examples: [
      {
        title: "Scope allowed mismatch narrowly",
        language: "vue",
        invalid:
          "<template>\n  <main data-allow-mismatch>\n    <UserProfile />\n  </main>\n</template>",
        valid: "<template>\n  <time data-allow-mismatch>{{ formattedNow }}</time>\n</template>",
      },
    ],
  },
  "vue/ssr/no-browser-api-in-setup": {
    description:
      "Flags browser API in setup in Vue SSR code before it leaks into runtime behavior.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Remove browser API in setup, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Move browser API usage to mounted",
        language: "vue",
        invalid: '<script setup lang="ts">\nconst width = window.innerWidth\n</script>',
        valid:
          '<script setup lang="ts">\nconst width = ref(0)\nonMounted(() => { width.value = window.innerWidth })\n</script>',
      },
    ],
  },
  "vue/ssr/no-random-or-local-time-render": {
    description:
      "Flags random or local time render in Vue SSR code before it leaks into runtime behavior.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Remove random or local time render, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid random render output",
        language: "vue",
        invalid: "<template>\n  <span>{{ Math.random() }}</span>\n</template>",
        valid:
          '<script setup lang="ts">\nconst id = useId()\n</script>\n\n<template>\n  <span>{{ id }}</span>\n</template>',
      },
    ],
  },
  "vue/ssr/use-id-for-stable-ids": {
    description:
      "Finds Vue SSR code that can be written with a clearer framework-supported pattern.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement: "Use the Vue-supported use id for stable ids pattern instead.",
    examples: [
      {
        title: "Use stable IDs",
        language: "vue",
        invalid: '<script setup lang="ts">\nconst id = Math.random().toString(36)\n</script>',
        valid: '<script setup lang="ts">\nconst id = useId()\n</script>',
      },
    ],
  },
  "vue/style/prefer-define-model": {
    description: "Finds Vue style code that should use the supported define model pattern instead.",
    why: "defineModel() keeps a component's model prop, update event, modifiers, and type in one compiler-checked declaration.",
    recommendedReplacement: "Use the Vue-supported define model pattern instead.",
    examples: [
      {
        title: "Use defineModel",
        language: "vue",
        invalid:
          "<script setup lang=\"ts\">\ndefineProps<{ modelValue: string }>()\nconst emit = defineEmits<{ 'update:modelValue': [value: string] }>()\n</script>",
        valid: '<script setup lang="ts">\nconst modelValue = defineModel<string>()\n</script>',
      },
    ],
  },
  "vue/style/prefer-props-destructure-defaults": {
    description:
      "Finds Vue style code that should use the supported props destructure defaults pattern instead.",
    why: "Vue's reactive props destructure expresses defaults at the binding site and avoids a separate withDefaults() wrapper in supported Vue versions.",
    recommendedReplacement: "Use the Vue-supported props destructure defaults pattern instead.",
    examples: [
      {
        title: "Use reactive props destructure defaults",
        language: "vue",
        invalid:
          "<script setup lang=\"ts\">\nwithDefaults(defineProps<{ label?: string }>(), {\n  label: 'Save',\n})\n</script>",
        valid:
          "<script setup lang=\"ts\">\nconst { label = 'Save' } = defineProps<{ label?: string }>()\n</script>",
      },
    ],
  },
  "vue/template/html-button-has-type": {
    description: "Requires native buttons to declare an explicit type attribute.",
    why: "Native buttons default to submit inside forms, which can trigger accidental submissions when a button is only meant to run a click action.",
    recommendedReplacement:
      'Add type="button", type="submit", or type="reset" to native button elements.',
    examples: [
      {
        title: "Add an explicit button type",
        language: "vue",
        invalid: '<template>\n  <button @click="save">Save</button>\n</template>',
        valid: '<template>\n  <button type="button" @click="save">Save</button>\n</template>',
      },
    ],
  },
  "vue/template/prefer-use-template-ref": {
    description:
      "Finds Vue template code that should use the supported use template ref pattern instead.",
    why: "useTemplateRef() links the script binding to the template ref name and gives TypeScript the element or component instance type.",
    recommendedReplacement: "Use the Vue-supported use template ref pattern instead.",
    examples: [
      {
        title: "Use useTemplateRef",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst input = ref<HTMLInputElement>()\n</script>\n\n<template>\n  <input ref="input">\n</template>',
        valid:
          '<script setup lang="ts">\nconst input = useTemplateRef<HTMLInputElement>(\'input\')\n</script>\n\n<template>\n  <input ref="input">\n</template>',
      },
    ],
  },
  "vue/template/prefer-true-attribute-shorthand": {
    description:
      "Finds native boolean attributes that bind the literal true value instead of using native attribute presence.",
    why: "Native boolean attributes are true by presence, so binding a literal true adds template noise without changing behavior.",
    recommendedReplacement:
      'Use the bare native attribute, such as disabled, instead of :disabled="true".',
    examples: [
      {
        title: "Use native boolean shorthand",
        language: "vue",
        invalid: '<template>\n  <button :disabled="true">Save</button>\n</template>',
        valid: "<template>\n  <button disabled>Save</button>\n</template>",
      },
    ],
  },
  "vue/template/prefer-same-name-prop-shorthand": {
    description:
      "Finds Vue props that can use Vue 3.4 same-name v-bind shorthand because the prop and bound variable have the same logical name.",
    why: "Same-name shorthand removes duplicated identifiers from templates while preserving the prop name readers need to see.",
    recommendedReplacement:
      "Use :prop or v-bind:prop only when the bound variable has the same logical name. See Vue same-name shorthand and eslint-plugin-vue v-bind-style sameNameShorthand.",
    examples: [
      {
        title: "Use same-name prop shorthand",
        language: "vue",
        invalid: '<template>\n  <MyCmp :my-prop="myProp" />\n</template>',
        valid: "<template>\n  <MyCmp :my-prop />\n</template>",
      },
      {
        title: "Keep explicit binding when names differ",
        language: "vue",
        invalid: '<template>\n  <MyCmp :my-prop="myProp" />\n</template>',
        valid: '<template>\n  <MyCmp :my-prop="selectedValue" />\n</template>',
      },
    ],
  },
  "vue/watch/no-async-watcheffect-after-await-read": {
    description:
      "Flags async watcheffect after await read in Vue watch code before it leaks into runtime behavior.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement:
      "Remove async watcheffect after await read, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Read watchEffect dependencies before await",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nwatchEffect(async () => {\n  await loadSettings()\n  console.log(userId.value)\n})\n</script>',
        valid:
          '<script setup lang="ts">\nwatchEffect(async () => {\n  const id = userId.value\n  await loadSettings()\n  console.log(id)\n})\n</script>',
      },
    ],
  },
  "vue/watch/no-onwatchercleanup-after-await": {
    description:
      "Flags onwatchercleanup after await in Vue watch code before it leaks into runtime behavior.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement:
      "Remove onwatchercleanup after await, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Register watcher cleanup before await",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nwatch(id, async () => {\n  await loadUser()\n  onWatcherCleanup(cancelLoad)\n})\n</script>',
        valid:
          '<script setup lang="ts">\nwatch(id, async () => {\n  onWatcherCleanup(cancelLoad)\n  await loadUser()\n})\n</script>',
      },
    ],
  },
  "vue/watch/require-post-flush-for-dom-read": {
    description:
      "Checks that Vue watch code includes the post flush for DOM read needed for predictable behavior.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement:
      "Add post flush for DOM read where Vue expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Use post-flush DOM reads",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nwatch(open, () => {\n  panel.value?.getBoundingClientRect()\n})\n</script>',
        valid:
          "<script setup lang=\"ts\">\nwatch(open, () => {\n  panel.value?.getBoundingClientRect()\n}, { flush: 'post' })\n</script>",
      },
    ],
  },
  "vue/watch/require-side-effect-cleanup": {
    description:
      "Checks that Vue watch code includes the side effect cleanup needed for predictable behavior.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement:
      "Add side effect cleanup where Vue expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Clean up watcher side effects",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nwatch(query, () => {\n  const timer = setTimeout(search, 300)\n})\n</script>',
        valid:
          '<script setup lang="ts">\nwatch(query, (_, __, onCleanup) => {\n  const timer = setTimeout(search, 300)\n  onCleanup(() => clearTimeout(timer))\n})\n</script>',
      },
    ],
  },
  "vueuse/no-nuxt-auto-import-collision": {
    description:
      "Flags nuxt auto import collision in VueUse project code before it leaks into runtime behavior.",
    why: "Auto-imports are global within a project. Explicit names and imports prevent local code from shadowing framework composables.",
    recommendedReplacement:
      "Remove nuxt auto import collision, or move it to the VueUse runtime/API that owns that behavior.",
    examples: [
      {
        title: "Alias VueUse Nuxt collisions",
        language: "ts",
        invalid:
          "import { useFetch } from '@vueuse/core'\n\nconst response = useFetch('/api/user')",
        valid:
          "import { useFetch as useVueUseFetch } from '@vueuse/core'\n\nconst response = useVueUseFetch('/api/user')",
      },
    ],
  },
  "vueuse/prefer-use-observers": {
    description:
      "Finds VueUse project code that should use the supported use observers pattern instead.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement: "Use the VueUse-supported use observers pattern instead.",
    examples: [
      {
        title: "Use VueUse observers",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nonMounted(() => {\n  const observer = new ResizeObserver(onResize)\n  observer.observe(panel.value!)\n})\n</script>',
        valid: '<script setup lang="ts">\nuseResizeObserver(panel, onResize)\n</script>',
      },
    ],
  },
  "vueuse/prefer-use-scroll-and-element": {
    description:
      "Finds VueUse project code that should use the supported use scroll and element pattern instead.",
    why: "VueUse scroll helpers provide reactive coordinates and manage listeners across mounting, target changes, and disposal.",
    recommendedReplacement: "Use the VueUse-supported use scroll and element pattern instead.",
    examples: [
      {
        title: "Use VueUse scroll helpers",
        language: "vue",
        invalid:
          "<script setup lang=\"ts\">\nconst y = ref(window.scrollY)\nwindow.addEventListener('scroll', () => { y.value = window.scrollY })\n</script>",
        valid: '<script setup lang="ts">\nconst { y } = useWindowScroll()\n</script>',
      },
    ],
  },
  "vueuse/prefer-use-storage": {
    description:
      "Finds VueUse project code that should use the supported use storage pattern instead.",
    why: "Manual storage reads and watches duplicate serialization, cross-tab synchronization, default handling, and reactive updates already handled by useStorage().",
    recommendedReplacement:
      "Use VueUse useStorage() for client storage so refs, serialization, and cleanup stay together.",
    examples: [
      {
        title: "Use VueUse storage",
        language: "ts",
        invalid:
          "const theme = ref(localStorage.getItem('theme') || 'light')\nwatch(theme, value => localStorage.setItem('theme', value))",
        valid: "const theme = useStorage('theme', 'light')",
      },
    ],
  },
  "vueuse/prefer-use-timers": {
    description:
      "Finds VueUse project code that should use the supported use timers pattern instead.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement: "Use the VueUse-supported use timers pattern instead.",
    examples: [
      {
        title: "Use VueUse timers",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst timer = setInterval(tick, 1000)\nonBeforeUnmount(() => clearInterval(timer))\n</script>',
        valid: '<script setup lang="ts">\nuseIntervalFn(tick, 1000)\n</script>',
      },
    ],
  },
  "vueuse/prefer-usebreakpoints": {
    description:
      "Finds VueUse project code that should use the supported useBreakpoints pattern instead.",
    why: "A one-time matchMedia() read does not stay reactive as the viewport changes; useBreakpoints() owns the media-query listeners and reactive state.",
    recommendedReplacement:
      "Use VueUse useBreakpoints() for responsive state that stays reactive and testable.",
    examples: [
      {
        title: "Use VueUse breakpoints",
        language: "ts",
        invalid: "const isMobile = ref(matchMedia('(max-width: 640px)').matches)",
        valid:
          "const breakpoints = useBreakpoints({ mobile: 640 })\nconst isMobile = breakpoints.smaller('mobile')",
      },
    ],
  },
  "vueuse/prefer-useclipboard": {
    description:
      "Finds VueUse project code that should use the supported useClipboard pattern instead.",
    why: "Direct clipboard calls require support checks, permission handling, copied state, and cleanup that useClipboard() already provides.",
    recommendedReplacement:
      "Use VueUse useClipboard() instead of wiring navigator.clipboard directly.",
    examples: [
      {
        title: "Use VueUse clipboard",
        language: "ts",
        invalid:
          "async function copy(text: string) {\n  await navigator.clipboard.writeText(text)\n}",
        valid: "const { copy } = useClipboard()",
      },
    ],
  },
  "vueuse/prefer-useevent-listener": {
    description:
      "Finds VueUse project code that should use the supported useEvent listener pattern instead.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement:
      "Use VueUse useEventListener() so the listener is removed with the component scope.",
    examples: [
      {
        title: "Use VueUse event listeners",
        language: "vue",
        invalid:
          "<script setup lang=\"ts\">\nonMounted(() => window.addEventListener('resize', onResize))\nonBeforeUnmount(() => window.removeEventListener('resize', onResize))\n</script>",
        valid:
          "<script setup lang=\"ts\">\nuseEventListener(window, 'resize', onResize)\n</script>",
      },
    ],
  },
  "vueuse/prefer-usewindow-size": {
    description:
      "Finds VueUse project code that should use the supported useWindow size pattern instead.",
    why: "Reading window dimensions directly misses later resizes unless the component owns listener setup and cleanup; useWindowSize() maintains reactive dimensions.",
    recommendedReplacement:
      "Use VueUse useWindowSize() instead of reading window dimensions by hand.",
    examples: [
      {
        title: "Use VueUse window size",
        language: "vue",
        invalid:
          "<script setup lang=\"ts\">\nconst width = ref(window.innerWidth)\nwindow.addEventListener('resize', () => { width.value = window.innerWidth })\n</script>",
        valid: '<script setup lang="ts">\nconst { width } = useWindowSize()\n</script>',
      },
    ],
  },
} satisfies Record<string, RuleDocumentationMetadata>;
