import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noModuleScopeRequestState } from "../../../src/rule-packs/nuxt/rules/nuxt/no-module-scope-request-state.ts";
import nuxtRulePack from "../../../src/rule-packs/nuxt/rules/nuxt.ts";

async function run(files: Record<string, string>) {
  const result = await runProjectFixture({
    framework: "nuxt",
    files,
    rules: [noModuleScopeRequestState],
  });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
    line: diagnostic.range?.line,
  }));
}

test("reports an in-flight promise shared by a Pinia action that runs during SSR", async () => {
  const diagnostics = await run({
    "app/store/userSettings.ts": `import { defineStore } from 'pinia'

let currencyChoicesLoadPromise: Promise<void> | null = null

export const useUserSettings = defineStore('userSettings', {
  state: () => ({ currencyChoices: [] as string[], showCurrencySelector: false }),
  actions: {
    async ensureCurrencyChoicesLoaded() {
      if (!currencyChoicesLoadPromise) {
        currencyChoicesLoadPromise = (async () => {
          await this.checkShowCurrencySelector()
          this.currencyChoices = await $fetch('/api/currencies')
        })()
      }
      try {
        await currencyChoicesLoadPromise
      }
      finally {
        currencyChoicesLoadPromise = null
      }
    },
    async checkShowCurrencySelector() {
      this.showCurrencySelector = true
    },
  },
})
`,
  });
  expect(diagnostics).toEqual([{ code: "NUXT0084", file: "app/store/userSettings.ts", line: 3 }]);
});

test.each([
  [
    "a composable cache filled with fetched data",
    "app/composables/useProduct.ts",
    `const products = new Map<string, unknown>()
export async function useProduct(id: string) {
  const product = await $fetch(\`/api/products/\${id}\`)
  products.set(id, product)
  return product
}`,
  ],
  [
    "a plugin that stores the current user",
    "app/plugins/user.ts",
    `let currentUser: unknown
export default defineNuxtPlugin(async () => {
  currentUser = await $fetch('/api/me')
})
export const getCurrentUser = () => currentUser`,
  ],
  [
    "a server-only plugin that stores request headers",
    "app/plugins/headers.server.ts",
    `let headers: Record<string, string> | undefined
export default defineNuxtPlugin(() => {
  headers = useRequestHeaders()
})`,
  ],
  [
    "a plain script block written from script setup",
    "app/components/Profile.vue",
    `<script lang="ts">
let profile: unknown
</script>
<script setup lang="ts">
const { data } = await useFetch('/api/profile')
profile = data.value
</script>`,
  ],
  [
    "a composable that records the Nuxt app",
    "app/composables/useTenant.ts",
    `let app: unknown
export function useTenant() {
  app = useNuxtApp()
}`,
  ],
  [
    "a write after a server early return in another function",
    "app/composables/useUser.ts",
    `let currentUser: unknown
function trackClientView() {
  if (import.meta.server) return
  console.info('view')
}
export async function useUser() {
  currentUser = await $fetch('/api/me')
}`,
  ],
  [
    "a Map declared with let",
    "app/composables/useProduct.ts",
    `let products = new Map<string, unknown>()
export async function useProduct(id: string) {
  products.set(id, await $fetch(\`/api/products/\${id}\`))
}`,
  ],
  [
    "a write after a nested callback's server return",
    "app/composables/useUser.ts",
    `let currentUser: unknown
export async function useUser() {
  onMounted(() => {
    if (import.meta.server) return
  })
  currentUser = await $fetch('/api/me')
}`,
  ],
])("reports %s", async (_, file, source) => {
  const diagnostics = await run({ [file]: source });
  expect(diagnostics).toMatchObject([{ code: "NUXT0084", file }]);
});

test.each([
  [
    "read-only lookup tables",
    "app/utils/labels.ts",
    `const LABELS = new Map([['a', 'A']])
const KNOWN = new Set(['a'])
export function label(key: string) {
  return KNOWN.has(key) ? LABELS.get(key) : key
}`,
  ],
  [
    "memoized pure values",
    "app/utils/format.ts",
    `const formatters = new Map<string, Intl.NumberFormat>()
export function format(locale: string, value: number) {
  let formatter = formatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale)
    formatters.set(locale, formatter)
  }
  return formatter.format(value)
}`,
  ],
  [
    "a WeakMap keyed by the Nuxt app",
    "app/composables/useAuthenticatedState.ts",
    `const statePromises = new WeakMap<object, Promise<void>>()
export function useAuthenticatedState() {
  const nuxtApp = useNuxtApp()
  statePromises.set(nuxtApp, $fetch('/api/me'))
}`,
  ],
  [
    "client-only plugins",
    "app/plugins/user.client.ts",
    `let currentUser: unknown
export default defineNuxtPlugin(async () => {
  currentUser = await $fetch('/api/me')
})`,
  ],
  [
    "writes behind import.meta.client",
    "app/composables/useUser.ts",
    `let currentUser: unknown
export async function useUser() {
  if (import.meta.client) {
    currentUser = await $fetch('/api/me')
  }
}`,
  ],
  [
    "writes after a server early return",
    "app/composables/useUser.ts",
    `let currentUser: unknown
export async function useUser() {
  if (import.meta.server) return
  currentUser = await $fetch('/api/me')
}`,
  ],
  [
    "callbacks registered after a server early return",
    "app/composables/useUser.ts",
    `let currentUser: unknown
export function useUser() {
  if (import.meta.server) return
  watchEffect(async () => {
    currentUser = await $fetch('/api/me')
  })
}`,
  ],
  [
    "writes in mounted hooks",
    "app/composables/useUser.ts",
    `let currentUser: unknown
export function useUser() {
  onMounted(async () => {
    currentUser = await $fetch('/api/me')
  })
}`,
  ],
  [
    "script setup bindings",
    "app/pages/index.vue",
    `<script setup lang="ts">
let profile: unknown
const { data } = await useFetch('/api/profile')
profile = data.value
</script>`,
  ],
  [
    "request counters",
    "app/composables/useSearch.ts",
    `let requestId = 0
export async function useSearch() {
  requestId++
  const id = requestId
  requestId = id + 1
}`,
  ],
  [
    "shadowed locals",
    "app/composables/useUser.ts",
    `let currentUser: unknown
export async function useUser() {
  let currentUser
  currentUser = await $fetch('/api/me')
  return currentUser
}`,
  ],
  [
    "module initialization",
    "app/utils/config.ts",
    `let config: unknown
config = await import('./defaults').then((module) => module.default)
export const getConfig = () => config`,
  ],
  [
    "server code",
    "server/utils/user.ts",
    `let currentUser: unknown
export async function getUser() {
  currentUser = await $fetch('/api/me')
}`,
  ],
  [
    "module-level $-prefixed helpers",
    "app/composables/useLabel.ts",
    `import { $t } from './i18n'
let label: string | undefined
let title: string | undefined
function $format(value: string) {
  return value.toUpperCase()
}
export function useLabel() {
  label = $format('hello')
  title = $t('title')
}`,
  ],
  [
    "lazily imported modules",
    "app/composables/useDefaults.ts",
    `let defaults: unknown
let messages: unknown
export async function useDefaults() {
  defaults = await import('./defaults')
  messages = await import('./messages').then((module) => module.default)
}`,
  ],
])("does not report %s", async (_, file, source) => {
  expect(await run({ [file]: source })).toEqual([]);
});

test("ships in the Strict Preset only", () => {
  expect(nuxtRulePack.presets.recommended).not.toContain("nuxt/ssr/no-module-scope-request-state");
  expect(nuxtRulePack.presets.strict).toContain("nuxt/ssr/no-module-scope-request-state");
});
