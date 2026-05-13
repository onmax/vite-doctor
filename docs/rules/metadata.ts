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
        title: "Avoid empty app vue shadow",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "nitro/context/no-navigateto-in-nitro": {
    description:
      "Flags navigateto in nitro in Nitro context code before it leaks into runtime behavior.",
    why: "Navigation helpers only work correctly in the runtime they were designed for. Returning the navigation result keeps redirects and aborts observable to Nuxt.",
    recommendedReplacement:
      "Remove navigateto in nitro, or move it to the Nitro runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid navigateto in nitro",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
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
        title: "Avoid usenuxtapp in nitro",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
      },
    ],
  },
  "nitro/request/prefer-assert-method": {
    description:
      "Finds Nitro request code that should use the supported assert method pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use assertMethod(event, method) at the top of single-method handlers.",
    examples: [
      {
        title: "Use assert method",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
      },
    ],
  },
  "nitro/request/prefer-get-request-ip": {
    description:
      "Finds Nitro request code that should use the supported get request IP pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Use getRequestIP(event) and configure trusted proxy handling centrally.",
    examples: [
      {
        title: "Use get request IP",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
      },
    ],
  },
  "nitro/runtime/require-event-runtime-config-in-server": {
    description:
      "Checks that Nitro runtime code includes the event runtime config in server needed for predictable behavior.",
    why: "Runtime configuration has different server and client visibility. Using the framework API keeps environment data typed and scoped.",
    recommendedReplacement: "Pass the event to useRuntimeConfig(event) in Nitro server handlers.",
    examples: [
      {
        title: "Add event runtime config in server",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
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
        title: "Avoid browser API",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
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
        title: "Avoid client composables",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
      },
    ],
  },
  "nitro/server/prefer-event-fetch": {
    description:
      "Finds Nitro server code that should use the supported event fetch pattern instead.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Use event.$fetch() for internal server calls that need request context.",
    examples: [
      {
        title: "Use event fetch",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
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
        title: "Add standard auth handler mount",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid broken internal to link",
        language: "vue",
        invalid: '<template>\n  <a href="/dashboard">Dashboard</a>\n</template>',
        valid: '<template>\n  <NuxtLink to="/dashboard">Dashboard</NuxtLink>\n</template>',
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
        title: "Avoid querycontent legacy API",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Nuxt-supported u button pattern instead.",
    examples: [
      {
        title: "Use u button",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "nuxt-ui/prefer-u-form-controls": {
    description:
      "Finds Nuxt project code that should use the supported u form controls pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Nuxt-supported u form controls pattern instead.",
    examples: [
      {
        title: "Use u form controls",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Use async data explicit key for refreshable",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Use async data handler pure",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Use async data no mutation methods",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Avoid nested autoimport assumption",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid composable after await",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "nuxt/context/no-legacy-process-client-server": {
    description:
      "Flags legacy process client server in Nuxt context code before it leaks into runtime behavior.",
    why: "Nuxt gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove legacy process client server, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid legacy process client server",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
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
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Use forward auth headers SSR",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Avoid await inside custom wrapper",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Avoid raw fetch in setup",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Add stable useAsyncData key",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Avoid browser global in universal code",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid browser side effects in setup",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid client conditional in template",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly": {
    description:
      "Flags time dependent render without nuxttime or clientonly in Nuxt hydration code before it leaks into runtime behavior.",
    why: "Server-rendered markup must match the first client render. Browser-only state, time, randomness, or hash-sensitive URLs can create hydration mismatches.",
    recommendedReplacement:
      "Remove time dependent render without nuxttime or clientonly, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid time dependent render without nuxttime or clientonly",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Use usecookie for initial client state",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid auto import collision",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid conflicting useFetch import",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
      },
    ],
  },
  "nuxt/imports/no-explicit-auto-import": {
    description:
      "Flags explicit auto import in Nuxt imports code before it leaks into runtime behavior.",
    why: "Auto-imports are global within a project. Explicit names and imports prevent local code from shadowing framework composables.",
    recommendedReplacement:
      "Remove explicit auto import, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid explicit auto import",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid route middleware API security",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "nuxt/no-global-refresh-without-justification": {
    description:
      "Flags global refresh without justification in Nuxt project code before it leaks into runtime behavior.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Remove global refresh without justification, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid global refresh without justification",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid manual action useFetch",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Avoid mutation toast in useFetch callback",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
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
        title: "Avoid subdir auto registration assumption",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "nuxt/post-fetch-requires-readonly-marker": {
    description:
      "Finds Nuxt project code that can be written with a clearer framework-supported pattern.",
    why: "Nuxt data fetching relies on stable keys, payload serialization, and request context. Bypassing those contracts can duplicate requests or lose SSR data.",
    recommendedReplacement:
      "Use the Nuxt-supported post fetch requires readonly marker pattern instead.",
    examples: [
      {
        title: "Use post fetch requires readonly marker",
        language: "ts",
        invalid:
          "const { data } = await useFetch('/api/orders', {\n  method: 'POST',\n  body: { status: 'draft' },\n})",
        valid:
          "const { data } = await useFetch('/api/orders', {\n  key: 'orders',\n  query: { status: 'draft' },\n})",
      },
    ],
  },
  "nuxt/preview-mode-global-refresh": {
    description:
      "Finds Nuxt project code that can be written with a clearer framework-supported pattern.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Nuxt-supported preview mode global refresh pattern instead.",
    examples: [
      {
        title: "Use preview mode global refresh",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "nuxt/project/prefer-app-directory-placement": {
    description:
      "Finds Nuxt project code that should use the supported app directory placement pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Nuxt-supported app directory placement pattern instead.",
    examples: [
      {
        title: "Use app directory placement",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid hash sensitive route fullpath in SSR markup",
        language: "ts",
        invalid: "<template>\n  <RouterView />\n</template>",
        valid: "<template>\n  <NuxtPage />\n</template>",
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
        title: "Avoid route object page key",
        language: "ts",
        invalid: "<template>\n  <RouterView />\n</template>",
        valid: "<template>\n  <NuxtPage />\n</template>",
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
        title: "Avoid router navigation in setup",
        language: "ts",
        invalid: "<template>\n  <RouterView />\n</template>",
        valid: "<template>\n  <NuxtPage />\n</template>",
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
        title: "Avoid useRoute in middleware",
        language: "ts",
        invalid: "<template>\n  <RouterView />\n</template>",
        valid: "<template>\n  <NuxtPage />\n</template>",
      },
    ],
  },
  "nuxt/routing/prefer-nuxt-useroute": {
    description:
      "Finds Nuxt routing code that should use the supported nuxt useRoute pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use Nuxt’s auto-imported useRoute() inside Nuxt app code.",
    examples: [
      {
        title: "Use nuxt useRoute",
        language: "ts",
        invalid: "<template>\n  <RouterView />\n</template>",
        valid: "<template>\n  <NuxtPage />\n</template>",
      },
    ],
  },
  "nuxt/routing/prefer-nuxtlink": {
    description: "Finds Nuxt routing code that should use the supported NuxtLink pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
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
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
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
        title: "Return navigateto in middleware",
        language: "ts",
        invalid: "<template>\n  <RouterView />\n</template>",
        valid: "<template>\n  <NuxtPage />\n</template>",
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
        title: "Avoid plain env in app code",
        language: "ts",
        invalid:
          "export default defineNuxtConfig({\n  runtimeConfig: {\n    public: { apiSecret: process.env.API_SECRET },\n  },\n})",
        valid:
          "export default defineNuxtConfig({\n  runtimeConfig: {\n    apiSecret: process.env.API_SECRET,\n    public: { apiBase: '/api' },\n  },\n})",
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
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Use the Nuxt-supported useheadsafe for untrusted values pattern instead.",
    examples: [
      {
        title: "Use useheadsafe for untrusted values",
        language: "ts",
        invalid: "useHead({\n  script: [{ src: 'https://example.com/widget.js' }],\n})",
        valid: "useHeadSafe({\n  script: [{ src: trustedWidgetUrl }],\n})",
      },
    ],
  },
  "nuxt/seo/prefer-seo-composables": {
    description:
      "Finds Nuxt seo code that should use the supported seo composables pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Nuxt-supported seo composables pattern instead.",
    examples: [
      {
        title: "Use seo composables",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid nested shared autoimport assumption",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid vue or nitro context in shared",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "nuxt/state/no-nonserializable-usestate": {
    description:
      "Flags nonserializable usestate in Nuxt state code before it leaks into runtime behavior.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Remove nonserializable usestate, or move it to the Nuxt runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid nonserializable usestate",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "nuxt/state/prefer-explicit-usestate-key-in-exported-composables": {
    description:
      "Finds Nuxt state code that should use the supported explicit usestate key in exported composables pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Use the Nuxt-supported explicit usestate key in exported composables pattern instead.",
    examples: [
      {
        title: "Use explicit usestate key in exported composables",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid personalized cached handler",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Use cached event handler",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Avoid dynamic new URL",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vite/assets/no-public-src-import": {
    description:
      "Flags public src import in Vite assets code before it leaks into runtime behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement:
      "Remove public src import, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid public src import",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid src absolute public URL",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid secret define",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid untyped define",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid unused define",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vite/env/no-broad-env-prefix": {
    description: "Flags broad env prefix in Vite env code before it leaks into runtime behavior.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Remove broad env prefix, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid broad env prefix",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid client secret pattern",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vite/env/no-empty-env-prefix": {
    description: "Flags empty env prefix in Vite env code before it leaks into runtime behavior.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Remove empty env prefix, or move it to the Vite runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid empty env prefix",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid untyped env",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vite/env/prefer-direct-import-meta-env-access": {
    description:
      "Finds Vite env code that should use the supported direct import meta env access pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Vite-supported direct import meta env access pattern instead.",
    examples: [
      {
        title: "Use direct import meta env access",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Add dispose for side effects",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vite/plugin/prefer-transform-filter": {
    description:
      "Finds Vite plugin code that should use the supported transform filter pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Vite-supported transform filter pattern instead.",
    examples: [
      {
        title: "Use transform filter",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vite/plugin/require-name": {
    description: "Checks that Vite plugin code includes the name needed for predictable behavior.",
    why: "Vite configuration runs in both dev and build pipelines. Narrow, explicit settings reduce surprises across SSR, workers, and local file access.",
    recommendedReplacement: "Add name where Vite expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Add name",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid broad fs allow",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
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
        title: "Avoid disabled fs strict",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
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
        title: "Avoid browser global in SSR entry",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid dynamic worker URL",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Avoid node API in worker",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
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
        title: "Add worker URL pattern",
        language: "ts",
        invalid:
          "export default defineConfig({\n  define: {\n    __APP_CONFIG__: { feature: true },\n  },\n})",
        valid:
          "export default defineConfig({\n  define: {\n    __FEATURE_ENABLED__: JSON.stringify(true),\n  },\n})",
      },
    ],
  },
  "vue/computed/no-async": {
    description: "Flags async in Vue computed code before it leaks into runtime behavior.",
    why: "Computed values should stay synchronous and side-effect free so Vue can cache them and update dependents predictably.",
    recommendedReplacement:
      "Move the async work to useFetch(), useAsyncData(), or an explicit action, and keep the computed getter synchronous.",
    examples: [
      {
        title: "Avoid async",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/computed/no-side-effects": {
    description: "Flags side effects in Vue computed code before it leaks into runtime behavior.",
    why: "Computed values should stay synchronous and side-effect free so Vue can cache them and update dependents predictably.",
    recommendedReplacement:
      "Return a derived value from computed(), and move writes or effects into a watcher, event handler, or explicit action.",
    examples: [
      {
        title: "Avoid side effects",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid untranslated text",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid unused translations",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/lifecycle/no-mutation-in-onupdated": {
    description:
      "Flags mutation in onupdated in Vue lifecycle code before it leaks into runtime behavior.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement:
      "Remove mutation in onupdated, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid mutation in onupdated",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Add cleanup",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Use defineProps watch getter",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/reactivity/no-prop-mutation": {
    description:
      "Flags prop mutation in Vue reactivity code before it leaks into runtime behavior.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Remove prop mutation, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid prop mutation",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/reactivity/no-ref-as-operand": {
    description:
      "Flags ref as operand in Vue reactivity code before it leaks into runtime behavior.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Remove ref as operand, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid ref as operand",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/reactivity/no-setup-props-destructure": {
    description:
      "Flags setup props destructure in Vue reactivity code before it leaks into runtime behavior.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Remove setup props destructure, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid setup props destructure",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/reactivity/prefer-composable-ref-return": {
    description:
      "Finds Vue reactivity code that should use the supported composable ref return pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Vue-supported composable ref return pattern instead.",
    examples: [
      {
        title: "Use composable ref return",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/security/restrict-v-html": {
    description: "Flags risky v HTML usage in Vue security code.",
    why: "Untrusted HTML and scripts are high-risk rendering surfaces. Keep them explicit, constrained, and routed through framework APIs that encode intent.",
    recommendedReplacement: "Keep v HTML behind the safest Vue API available for that surface.",
    examples: [
      {
        title: "Restrict v HTML",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Use data allow mismatch surgical",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid browser API in setup",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid random or local time render",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Use use id for stable ids",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/style/prefer-define-model": {
    description: "Finds Vue style code that should use the supported define model pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Vue-supported define model pattern instead.",
    examples: [
      {
        title: "Use define model",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/style/prefer-props-destructure-defaults": {
    description:
      "Finds Vue style code that should use the supported props destructure defaults pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Vue-supported props destructure defaults pattern instead.",
    examples: [
      {
        title: "Use props destructure defaults",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/template/no-v-if-with-v-for": {
    description:
      "Flags v if with v for in Vue template code before it leaks into runtime behavior.",
    why: "Vue gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Remove v if with v for, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid v if with v for",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/template/prefer-use-template-ref": {
    description:
      "Finds Vue template code that should use the supported use template ref pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the Vue-supported use template ref pattern instead.",
    examples: [
      {
        title: "Use use template ref",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/template/require-v-for-key": {
    description:
      "Checks that Vue template code includes the v for key needed for predictable behavior.",
    why: "Vue gives this pattern a specific contract. Staying inside that contract makes the code easier to test, refactor, and run across server and client runtimes.",
    recommendedReplacement:
      "Add v for key where Vue expects it, close to the code that depends on it.",
    examples: [
      {
        title: "Add v for key",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
      },
    ],
  },
  "vue/watch/no-after-await": {
    description: "Flags after await in Vue watch code before it leaks into runtime behavior.",
    why: "Effects that outlive their component create leaks and stale updates. Register cleanup where Vue or VueUse can dispose it automatically.",
    recommendedReplacement:
      "Remove after await, or move it to the Vue runtime/API that owns that behavior.",
    examples: [
      {
        title: "Avoid after await",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid async watcheffect after await read",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid onwatchercleanup after await",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Add post flush for DOM read",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Add side effect cleanup",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst props = defineProps<{ count: number }>()\n</script>\n\n<template>\n  <button @click="props.count++">{{ props.count }}</button>\n</template>',
        valid:
          '<script setup lang="ts">\nconst count = defineModel<number>(\'count\')\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>',
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
        title: "Avoid nuxt auto import collision",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Use use observers",
        language: "ts",
        invalid:
          "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return $fetch('/api/internal', { method: 'POST', body })\n})",
        valid:
          "export default defineEventHandler(async (event) => {\n  const body = await readValidatedBody(event, schema.parse)\n  return event.$fetch('/api/internal', { method: 'POST', body })\n})",
      },
    ],
  },
  "vueuse/prefer-use-scroll-and-element": {
    description:
      "Finds VueUse project code that should use the supported use scroll and element pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement: "Use the VueUse-supported use scroll and element pattern instead.",
    examples: [
      {
        title: "Use use scroll and element",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "vueuse/prefer-use-storage": {
    description:
      "Finds VueUse project code that should use the supported use storage pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Use VueUse useStorage() for client storage so refs, serialization, and cleanup stay together.",
    examples: [
      {
        title: "Use use storage",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Use use timers",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "vueuse/prefer-usebreakpoints": {
    description:
      "Finds VueUse project code that should use the supported useBreakpoints pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Use VueUse useBreakpoints() for responsive state that stays reactive and testable.",
    examples: [
      {
        title: "Use useBreakpoints",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "vueuse/prefer-useclipboard": {
    description:
      "Finds VueUse project code that should use the supported useClipboard pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Use VueUse useClipboard() instead of wiring navigator.clipboard directly.",
    examples: [
      {
        title: "Use useClipboard",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
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
        title: "Use useEvent listener",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
  "vueuse/prefer-usewindow-size": {
    description:
      "Finds VueUse project code that should use the supported useWindow size pattern instead.",
    why: "Vue and Nuxt reactivity depends on stable references and serializable state. Hidden snapshots or mutable inputs make updates harder to track.",
    recommendedReplacement:
      "Use VueUse useWindowSize() instead of reading window dimensions by hand.",
    examples: [
      {
        title: "Use useWindow size",
        language: "ts",
        invalid:
          "export default defineNuxtPlugin(() => {\n  const route = useRoute()\n  console.log(route.fullPath)\n})",
        valid:
          "export default defineNuxtPlugin(() => {\n  const nuxtApp = useNuxtApp()\n  nuxtApp.hook('page:finish', () => {})\n})",
      },
    ],
  },
} satisfies Record<string, RuleDocumentationMetadata>;
