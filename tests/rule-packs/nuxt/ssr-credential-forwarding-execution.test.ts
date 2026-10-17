import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../rule-fixtures.ts";
import { forwardAuthHeadersSsr } from "../../../src/rule-packs/nuxt/rules/nuxt/forward-auth-headers-ssr.ts";

const ruleId = forwardAuthHeadersSsr.meta.id;

async function diagnose(source: string, file = "app/composables/useSettings.ts") {
  const result = await runNuxtAppRuleFixture(forwardAuthHeadersSsr, source, file);
  return result.diagnostics.map((item) => item.ruleId);
}

const injectionState = `const [provideSettings, useSettingsRaw] = createInjectionState(() => {
  const search = ref('')
  async function loadPickerItems() {
    return await $fetch('/api/settings/products', { query: { search: search.value } })
  }
  function onPickerOpen(open: boolean) {
    if (open) loadPickerItems()
  }
  async function postReplacement(id: string) {
    await $fetch('/api/settings/replacements', { method: 'POST', body: { id } })
  }
  async function saveEditor() {
    await postReplacement('a')
    return true
  }
  watch(search, () => loadPickerItems())
  return { onPickerOpen, saveEditor }
})
export { provideSettings }
export function useSettings() {
  return useSettingsRaw()
}`;

test("ignores requests that only run from event handlers and returned commands", async () => {
  expect(await diagnose(injectionState)).toEqual([]);
});

test.each([
  [
    "a returned helper",
    `export function useAccount() {\n  async function save() {\n    await $fetch('/api/account', { method: 'POST' })\n  }\n  return { save }\n}`,
  ],
  [
    "an async-data handler with server: false",
    `export function useAccount() {\n  return useAsyncData('account', () => $fetch('/api/account'), { server: false })\n}`,
  ],
  [
    "an uncalled local function",
    `<script setup lang="ts">\nasync function load() {\n  return await $fetch('/api/user')\n}\n</script>`,
  ],
])("ignores requests without SSR execution evidence: %s", async (_, source) => {
  const file = source.startsWith("<script")
    ? "app/pages/user.vue"
    : "app/composables/useAccount.ts";
  expect(await diagnose(source, file)).toEqual([]);
});

test.each([
  [
    "top-level script setup",
    "app/pages/index.vue",
    `<script setup lang="ts">\nconst user = await $fetch('/api/user')\n</script>`,
  ],
  [
    "a useAsyncData handler in script setup",
    "app/pages/index.vue",
    `<script setup lang="ts">\nconst { data } = await useAsyncData('client', async () => {\n  const metadata = await $fetch('/api/auth/oauth2/public-client-prelogin', { method: 'POST' })\n  return metadata\n})\n</script>`,
  ],
  [
    "a useAsyncData handler returned from a composable",
    "app/composables/useWrappedUser.ts",
    `export async function useWrappedUser() {\n  return await useAsyncData(() => $fetch('/api/user'))\n}`,
  ],
  [
    "a composable body",
    "app/composables/useUser.ts",
    `export async function useUser() {\n  return await $fetch('/api/user')\n}`,
  ],
  [
    "a local function called during setup",
    "app/pages/index.vue",
    `<script setup lang="ts">\nasync function load() {\n  return await $fetch('/api/user')\n}\nconst user = await load()\n</script>`,
  ],
  [
    "a universal plugin",
    "app/plugins/user.ts",
    `export default defineNuxtPlugin(async () => {\n  await $fetch('/api/user')\n})`,
  ],
  [
    "route middleware",
    "app/middleware/auth.ts",
    `export default defineNuxtRouteMiddleware(async () => {\n  await $fetch('/api/session')\n})`,
  ],
  [
    "a setup() function",
    "app/components/User.vue",
    `<script lang="ts">\nexport default defineNuxtComponent({\n  async setup() {\n    const user = await $fetch('/api/user')\n    return { user }\n  },\n})\n</script>`,
  ],
])("reports SSR-executed requests: %s", async (_, file, source) => {
  expect(await diagnose(source, file)).toEqual([ruleId]);
});

test.each([
  [
    "async-data options in a local const",
    `export function useAccount() {\n  const options = { server: false }\n  return useAsyncData('account', () => $fetch('/api/account'), options)\n}`,
  ],
  [
    "async-data options built from a spread",
    `const base = { server: false }\nexport function useAccount() {\n  return useAsyncData('account', () => $fetch('/api/account'), { ...base })\n}`,
  ],
  [
    "async-data options from a parameter",
    `const options = { lazy: true }\nexport function useAccount(options) {\n  return useAsyncData('account', () => $fetch('/api/account'), options)\n}`,
  ],
  [
    "a deferred watcher",
    `export function useAccount(id) {\n  watch(id, () => $fetch('/api/account'))\n}`,
  ],
  [
    "watchEffect inside onMounted",
    `export function useAccount() {\n  onMounted(() => {\n    watchEffect(() => $fetch('/api/account'))\n  })\n}`,
  ],
  [
    "watchPostEffect",
    `export function useAccount() {\n  watchPostEffect(() => $fetch('/api/account'))\n}`,
  ],
])("ignores requests whose SSR execution is not proven: %s", async (_, source) => {
  expect(await diagnose(source, "app/composables/useAccount.ts")).toEqual([]);
});

test.each([
  [
    "async-data options in a local const without server: false",
    `export function useAccount() {\n  const options = { lazy: true }\n  return useAsyncData('account', () => $fetch('/api/account'), options)\n}`,
  ],
  ["watchEffect", `export function useAccount() {\n  watchEffect(() => $fetch('/api/account'))\n}`],
])("reports requests that run during SSR: %s", async (_, source) => {
  expect(await diagnose(source, "app/composables/useAccount.ts")).toEqual([ruleId]);
});
