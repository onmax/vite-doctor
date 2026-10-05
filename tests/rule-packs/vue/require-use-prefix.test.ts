import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.js";
import { requireUsePrefix } from "../../../src/rule-packs/vue/rules/vue/index.js";
import vueRulePack from "../../../src/rule-packs/vue/rules/vue/index.js";

const ruleId = "vue/composables/require-use-prefix";

async function runVue(source: string, file = "src/composables/state.ts") {
  return runRuleFixture({ rule: requireUsePrefix, framework: "vue", files: { [file]: source } });
}

test("is part of the Vue recommended preset", () => {
  expect(vueRulePack.presets.recommended).toContain(ruleId);
});

test.each([
  [
    "lifecycle hook",
    `import { onMounted, ref } from 'vue'\nexport function cartState() {\n  const items = ref([])\n  onMounted(() => hydrate(items))\n  return { items }\n}`,
    "onMounted",
  ],
  [
    "inject",
    `import { inject } from 'vue'\nexport function themeValue() {\n  return inject(ThemeKey)\n}`,
    "inject",
  ],
  [
    "provide",
    `import { provide } from 'vue'\nexport const registerTheme = (theme: Theme) => {\n  provide(ThemeKey, theme)\n}`,
    "provide",
  ],
  [
    "getCurrentInstance",
    `import { getCurrentInstance } from 'vue'\nexport function emitter() {\n  return getCurrentInstance()!.emit\n}`,
    "getCurrentInstance",
  ],
  [
    "another composable",
    `import { useRoute } from 'vue-router'\nexport function currentSlug(): string {\n  return String(useRoute().params.slug)\n}`,
    "useRoute",
  ],
  [
    "auto-imported composable",
    `export async function loadProfile() {\n  const { data } = await useFetch('/api/profile')\n  return data\n}`,
    "useFetch",
  ],
])("reports exported functions that call a setup-bound API (%s)", async (_label, source, api) => {
  const result = await runVue(source);
  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic).toMatchObject({ ruleId, code: "VUE0026", severity: "warn" });
  expect(diagnostic!.why).toContain(`${api}()`);
  expect(diagnostic!.suggestion).toMatch(/use[A-Z]/);
});

test("reports locally declared functions exported through specifiers at the declaration", async () => {
  const result = await runVue(
    `import { onUnmounted } from 'vue'\nfunction subscribe() {\n  onUnmounted(() => {})\n}\nexport { subscribe as subscribeToFeed }`,
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.why).toContain("subscribeToFeed()");
  expect(result.diagnostics[0]!.range?.line).toBe(2);
});

test("reports instances dereferenced through a local binding", async () => {
  const result = await runVue(
    `import { getCurrentInstance } from 'vue'\nexport function emitChange(value: string) {\n  const instance = getCurrentInstance()\n  instance!.emit('change', value)\n}`,
  );
  expect(result.diagnostics).toHaveLength(1);
});

test("reports the draft documentation example", async () => {
  const result = await runRuleFixture({
    rule: requireUsePrefix,
    framework: "nuxt",
    files: {
      "app/composables/cart.ts": `export function cartState() {\n  const items = useState<CartItem[]>('cart', () => [])\n  onMounted(() => hydrateCart(items))\n  return { items }\n}`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VUE0026"]);
});

test.each([
  [
    "use-prefixed composable",
    `export function useCart() { onMounted(() => {}); return useState('cart') }`,
  ],
  [
    "reactive state only",
    `import { computed, reactive, ref, watch } from 'vue'\nexport function createCounter() { return ref(0) }\nexport function counterState() {\n  const count = ref(0)\n  const state = reactive({ open: false })\n  const doubled = computed(() => count.value * 2)\n  watch(count, () => {})\n  return { count, state, doubled }\n}`,
  ],
  [
    "define and create factories",
    `export const defineCartState = () => { const items = inject(CartKey); onMounted(() => {}); return items }\nexport function createCartContext() { provide(CartKey, useCartStore()); return useRoute() }`,
  ],
  [
    "global state helpers",
    `import { createGlobalState, createSharedComposable, createInjectionState } from '@vueuse/core'\nexport const useGlobal = createGlobalState(() => { onMounted(() => {}); return ref(0) })\nexport const useShared = createSharedComposable(() => useMouse())\nexport const [provideCounter, useCounter] = createInjectionState(() => ref(0))`,
  ],
  [
    "Pinia store definitions and store calls",
    `export const cartStore = defineStore('cart', () => { const route = useRoute(); onMounted(() => {}); return { route } })\nexport function addToCart(item: Item) { useCartStore().add(item) }`,
  ],
  [
    "callbacks and nested functions",
    `export const handler = defineEventListener(() => useRoute())\nexport function createHandler() { return () => useRoute() }\nexport function subscribe(bus: Bus) { bus.on('x', () => { onMounted(() => {}) }) }`,
  ],
  [
    "on, tryOn, provide and inject helpers",
    `export function onClickAway(target: Target) { useEventListener(target, 'click', () => {}) }\nexport function tryOnMounted(fn: () => void) { if (getCurrentInstance()) onMounted(fn); else fn() }\nexport function provideTheme(theme: Theme) { provide(ThemeKey, theme) }\nexport function injectTheme() { return inject(ThemeKey) }`,
  ],
  [
    "context guarded helpers",
    `export function safeMounted(fn: () => void) {\n  const instance = getCurrentInstance()\n  if (instance) onMounted(fn)\n  else fn()\n}\nexport function maybeTheme() { return hasInjectionContext() ? inject(ThemeKey) : undefined }\nexport function isInsideComponent() { return !!getCurrentInstance() }`,
  ],
  [
    "instance lookups that tolerate a missing instance",
    `export function lifecycleTarget(target?: ComponentInternalInstance) { return target || getCurrentInstance() }\nexport function currentProxy() { return getCurrentInstance()?.proxy }`,
  ],
  [
    "ref, computed and watch helper families",
    `export function refDebounced(value: Ref<string>) { const fn = useDebounceFn(() => {}); return ref(value) }\nexport function computedInject(key: InjectionKey<number>) { return computed(() => inject(key)) }\nexport function watchRoute(cb: () => void) { watch(() => useRoute().path, cb) }`,
  ],
  [
    "app context accessors",
    `export function apiBase() { return useRuntimeConfig().public.apiBase }\nexport function translate(key: string) { return useNuxtApp().$i18n.t(key) }\nexport function headers() { return useRequestHeaders(['cookie']) }`,
  ],
  ["default exports", `export default function cartState() { onMounted(() => {}) }`],
  [
    "PascalCase components and plugin installers",
    `export function CartBadge() { const cart = inject(CartKey); return h('span', cart) }\nexport function install(app: App) { app.provide(CartKey, {}) }`,
  ],
  [
    "lookalike APIs from non-Vue sources",
    `import { inject } from 'vitest'\nimport { onMounted } from './lifecycle'\nexport function setupValue() { return inject('value') }\nexport function startApp() { onMounted() }`,
  ],
  [
    "build-time and server use* helpers",
    `import { useLogger, useNuxt } from '@nuxt/kit'\nimport { useSession } from 'h3'\nexport function setupModule() { useLogger('x'); return useNuxt() }\nexport function session(event: H3Event) { return useSession(event, { password: '' }) }`,
  ],
  ["non-function exports", `export const route = useRoute()\nexport const items = ref([])`],
])("does not report %s", async (_label, source) => {
  const result = await runVue(source);
  expect(result.diagnostics).toHaveLength(0);
});

test("does not report server files where use* names are Nitro utilities", async () => {
  const result = await runRuleFixture({
    rule: requireUsePrefix,
    framework: "nuxt",
    files: {
      "server/utils/cache.ts": `export function cacheStorage() { return useStorage('cache') }`,
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("leaves Nuxt utils directories to the Nuxt placement rule", async () => {
  const result = await runRuleFixture({
    rule: requireUsePrefix,
    framework: "nuxt",
    files: {
      "app/utils/track.ts": `export function trackPageView() {\n  const route = useRoute()\n  onMounted(() => analytics.page(route.fullPath))\n}`,
      "app/composables/track.ts": `export function trackPageView() {\n  onMounted(() => analytics.page())\n}`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
    expect.stringMatching(/app\/composables\/track\.ts$/),
  ]);
});

test("treats Nuxt app-context reads as callable outside setup but Vue Router's useRouter as setup-bound", async () => {
  const nuxt = await runRuleFixture({
    rule: requireUsePrefix,
    framework: "nuxt",
    files: {
      "app/composables/nav.ts": `export function goHome() { return useRouter().push('/') }\nexport function seedCache(key: string, value: Detail) {\n  useNuxtData<Detail>(key).data.value = value\n}\nexport function cartItems() { return useState<Item[]>('cart', () => []) }\nexport function token() { return useCookie('token').value }`,
    },
  });
  expect(nuxt.diagnostics).toHaveLength(0);
  const vue = await runVue(
    `import { useRouter } from 'vue-router'\nexport function goHome() { return useRouter().push('/') }`,
  );
  expect(vue.diagnostics).toHaveLength(1);
});
