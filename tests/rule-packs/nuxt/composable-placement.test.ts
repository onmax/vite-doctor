import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.js";
import nuxtRulePack, {
  noComposableInUtils,
  noStatelessComposable,
} from "../../../src/rule-packs/nuxt/rules/nuxt/index.js";
import { getRuleDocuments, rulesCollectionSource } from "../../../docs/rules/source.js";

const utilsRule = "nuxt/structure/no-composable-in-utils";
const statelessRule = "nuxt/structure/no-stateless-composable";

function runNuxt(rule: typeof noComposableInUtils, files: Record<string, string>) {
  return runRuleFixture({ rule, framework: "nuxt", files });
}

test("places setup-bound utils in Recommended and plain composables in Strict only", () => {
  expect(nuxtRulePack.presets.recommended).toContain(utilsRule);
  expect(nuxtRulePack.presets.recommended).not.toContain(statelessRule);
  expect(nuxtRulePack.presets.strict).toEqual(expect.arrayContaining([utilsRule, statelessRule]));
});

test("documents the Strict-only rule with a strict run command", async () => {
  const documents = getRuleDocuments();
  const strict = documents.find((rule) => rule.id === statelessRule)!;
  const recommended = documents.find((rule) => rule.id === utilsRule)!;
  expect(strict.diagnosticCodes).toEqual(["NUXT0078"]);
  expect(recommended.diagnosticCodes).toEqual(["NUXT0077"]);
  expect(await rulesCollectionSource.getItem(strict.key)).toContain(
    `pnpm nuxt doctor --extends auto,nuxt/strict --rules ${statelessRule}`,
  );
  expect(await rulesCollectionSource.getItem(recommended.key)).toContain(
    `pnpm nuxt doctor --rules ${utilsRule}`,
  );
});

test("NUXT0077 reports the documented utils example", async () => {
  const result = await runNuxt(noComposableInUtils, {
    "app/utils/track.ts": `export function trackPageView() {\n  const route = useRoute()\n  onMounted(() => analytics.page(route.fullPath))\n}`,
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    ruleId: utilsRule,
    code: "NUXT0077",
    severity: "warn",
  });
  expect(result.diagnostics[0]!.why).toContain("trackPageView() calls useRoute()");
  expect(result.diagnostics[0]!.suggestion).toContain("useTrackPageView");
});

test.each([
  ["inject", `export const theme = () => inject(ThemeKey)`],
  [
    "provide",
    `import { provide } from 'vue'\nexport function shareTheme(theme: Theme) { provide(ThemeKey, theme) }`,
  ],
  ["a use-prefixed composable", `export function useCart() { return useFetch('/api/cart') }`],
  ["a default export", `export default function () { onUnmounted(() => {}) }`],
])("NUXT0077 reports utils functions that call %s", async (_label, source) => {
  const result = await runNuxt(noComposableInUtils, { "app/utils/setup-bound.ts": source });
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0077"]);
});

test("NUXT0077 names default exports after the file Nuxt derives them from", async () => {
  const result = await runNuxt(noComposableInUtils, {
    "app/utils/track-page.ts": `export default function () { onMounted(() => {}) }`,
  });
  expect(result.diagnostics[0]!.why).toContain("trackPage()");
});

test("NUXT0077 resolves the Nuxt 3 root utils directory", async () => {
  const result = await runRuleFixture({
    rule: noComposableInUtils,
    framework: "nuxt",
    dependencies: { nuxt: "^3.15.0" },
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})",
      "utils/track.ts": `export function trackPageView() { onMounted(() => {}) }`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0077"]);
});

test("NUXT0077 resolves layer utils directories", async () => {
  const result = await runNuxt(noComposableInUtils, {
    "nuxt.config.ts": "export default defineNuxtConfig({ extends: ['./layers/base'] })",
    "layers/base/nuxt.config.ts": "export default defineNuxtConfig({})",
    "layers/base/app/utils/track.ts": `export function trackPageView() { onMounted(() => {}) }`,
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0077"]);
});

test.each([
  [
    "plain helpers",
    `export function slugify(input: string) { return input.toLowerCase() }\nexport const sum = (a: number, b: number) => a + b`,
  ],
  [
    "Nuxt app-context reads",
    `export function apiBase() { return useRuntimeConfig().public.apiBase }\nexport async function goHome() { await navigateTo('/') ; return useRouter().currentRoute.value }\nexport function cart() { return useState<Item[]>('cart', () => []) }\nexport function plugin() { return useNuxtApp().$plugin }`,
  ],
  ["Pinia store calls", `export function addToCart(item: Item) { useCartStore().add(item) }`],
  ["reactive state creation", `export function counter() { return ref(0) }`],
  [
    "setup-bound calls in nested callbacks",
    `export function createTracker(bus: Bus) { bus.on('page', () => { onMounted(() => {}) }) }`,
  ],
  [
    "context-guarded helpers",
    `export function tryOnMount(fn: () => void) { if (getCurrentInstance()) onMounted(fn); else fn() }`,
  ],
])("NUXT0077 ignores %s in utils", async (_label, source) => {
  const result = await runNuxt(noComposableInUtils, { "app/utils/helpers.ts": source });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ["composables/", "app/composables/track.ts"],
  ["server/utils/", "server/utils/track.ts"],
  ["shared/utils/", "shared/utils/track.ts"],
])("NUXT0077 ignores %s", async (_label, file) => {
  const result = await runNuxt(noComposableInUtils, {
    [file]: `export function trackPageView() { const route = useRoute(); onMounted(() => {}) }`,
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("NUXT0078 reports the documented composables example", async () => {
  const result = await runNuxt(noStatelessComposable, {
    "app/composables/useSlugify.ts": `export function useSlugify(input: string) {\n  return input.toLowerCase().replace(/\\s+/g, '-')\n}`,
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    ruleId: statelessRule,
    code: "NUXT0078",
    severity: "info",
  });
  expect(result.diagnostics[0]!.suggestion).toContain("rename it to slugify");
});

test.each([
  [
    "module constants",
    `const SEPARATOR = '-'\nexport const useJoin = (parts: string[]) => parts.join(SEPARATOR)`,
  ],
  [
    "plain module helpers",
    `function clamp(n: number) { return Math.min(1, Math.max(0, n)) }\nexport function useClamp(n: number) { return clamp(n) }`,
  ],
  [
    "third-party imports",
    `import { format } from 'date-fns'\nexport function useFormatDate(date: Date) { return format(date, 'yyyy') }`,
  ],
  [
    "JavaScript globals",
    `export function useEncoded(value: string) { return encodeURIComponent(JSON.stringify({ value, at: Date.now() })) }`,
  ],
])("NUXT0078 reports use* helpers that only use %s", async (_label, source) => {
  const result = await runNuxt(noStatelessComposable, { "app/composables/helpers.ts": source });
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0078"]);
});

test.each([
  ["Vue reactivity", `export function useCounter() { const count = ref(0); return { count } }`],
  [
    "Vue imports",
    `import { toValue } from 'vue'\nexport function useLabel(value: MaybeRefOrGetter<string>) { return toValue(value).trim() }`,
  ],
  ["other composables", `export function useApi() { return useFetch('/api') }`],
  ["Nuxt utilities", `export function useGoHome() { return () => navigateTo('/') }`],
  [
    "lifecycle hooks in callbacks",
    `export function useLater(fn: () => void) { return () => onMounted(fn) }`,
  ],
  [
    "module-level reactive state",
    `const state = reactive({ open: false })\nexport function useMenu() { return state }`,
  ],
  [
    "module helpers that use Vue",
    `function createState() { return ref(0) }\nexport function useShared() { return createState() }`,
  ],
  [
    "imported project state",
    `import { cartState } from '~/state/cart'\nexport function useCartItems() { return cartState.items }`,
  ],
  [
    "unknown auto-imports",
    `export function useShortcuts() { defineShortcuts({ meta_k: () => {} }) }`,
  ],
  [
    "framework imports",
    `import { storeToRefs } from 'pinia'\nexport function useRefs(store: Store) { return storeToRefs(store) }`,
  ],
  ["non-use exports", `export function slugify(input: string) { return input.toLowerCase() }`],
  ["factory exports", `export const useGlobal = createGlobalState(() => ({ count: 0 }))`],
  ["default exports", `export default function useThing() { return 1 }`],
])("NUXT0078 ignores composables that use %s", async (_label, source) => {
  const result = await runNuxt(noStatelessComposable, { "app/composables/useThing.ts": source });
  expect(result.diagnostics).toHaveLength(0);
});

test("NUXT0078 keeps calls to unresolved auto-imports out of scope without a manifest", async () => {
  const source = `export function useSlug(input: string) { return slugify(input) }`;
  const result = await runNuxt(noStatelessComposable, {
    "app/composables/useSlug.ts": source,
    "app/utils/slugify.ts": `export function slugify(input: string) { return input.toLowerCase() }`,
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("NUXT0078 only inspects composables directories", async () => {
  const result = await runNuxt(noStatelessComposable, {
    "app/utils/useSlugify.ts": `export function useSlugify(input: string) { return input.trim() }`,
    "server/utils/useSlugify.ts": `export function useSlugify(input: string) { return input.trim() }`,
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  `export function invokeHook(onMounted: () => void) { onMounted() }`,
  `export function invokeHook({ provide }: { provide: () => void }) { provide() }`,
  `export function invokeHook() { if (true) { var onMounted = () => {} } onMounted() }`,
  `export function invokeHook(getCurrentInstance: () => object) { return getCurrentInstance().value }`,
  `export function invokeHook() { const inject = () => 1; return inject() }`,
  `const useValue = () => 1; export function invokeHook() { return useValue() }`,
  `import { onMounted } from 'vue'; export function invokeHook(onMounted: () => void) { onMounted() }`,
])("NUXT0077 respects lexical bindings: %s", async (source) => {
  const result = await runNuxt(noComposableInUtils, { "app/utils/helpers.ts": source });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  `export function track() { const instance = getCurrentInstance(); if (instance) console.debug('setup'); return instance.proxy }`,
  `export function track() { const instance = getCurrentInstance(); { const instance = true; if (instance) onMounted(() => {}) } }`,
  `export function track(fn: () => void) { if (getCurrentInstance()) console.debug('setup'); onMounted(fn) }`,
  `export function track(fn: () => void) { if (!getCurrentInstance()) onMounted(fn) }`,
  `export function track(fn: () => void) { getCurrentInstance() || onMounted(fn) }`,
  `export function track(fn: () => void) { getCurrentInstance() ? fn() : onMounted(fn) }`,
  `export function track(fn: () => void) { if (getCurrentInstance() || fn()) onMounted(fn) }`,
  `export function track(getCurrentInstance: () => boolean) { if (getCurrentInstance()) onMounted(() => {}) }`,
  `export function track() { { const onMounted = () => {}; onMounted() } onMounted(() => {}) }`,
])("NUXT0077 reports unprotected setup calls: %s", async (source) => {
  const result = await runNuxt(noComposableInUtils, { "app/utils/helpers.ts": source });
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0077"]);
});

test.each([
  `export function track() { const instance = getCurrentInstance(); if (instance) return instance.proxy }`,
  `export function track(fn: () => void) { if (hasInjectionContext()) { provide('key', fn) } }`,
  `export function track(fn: () => void) { getCurrentInstance() && onMounted(fn) }`,
  `export function track(fn: () => void) { !getCurrentInstance() || onMounted(fn) }`,
  `export function track(fn: () => void) { if (!getCurrentInstance()) return; onMounted(fn) }`,
  `export function track(fn: () => void) { const instance = getCurrentInstance(); if (instance) onMounted(fn) }`,
  `export function track(fn: () => void) { getCurrentInstance() ? onMounted(fn) : fn() }`,
])("NUXT0077 accepts protected setup calls: %s", async (source) => {
  const result = await runNuxt(noComposableInUtils, { "app/utils/helpers.ts": source });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  `export function useCounter() { { const ref = 'plain' } return ref(0) }`,
  `export function useCounter() { const plain = (ref: string) => ref; return ref(0) }`,
  `export function useCounter() { for (const ref of []) {} return ref(0) }`,
  `export function useCounter() { try {} catch (ref) {} return ref(0) }`,
])("NUXT0078 preserves framework references outside shadows: %s", async (source) => {
  const result = await runNuxt(noStatelessComposable, { "app/composables/useCounter.ts": source });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  `export function useCounter(ref: () => number) { return ref() }`,
  `import { ref } from 'vue'; export function useCounter() { const ref = () => 1; return ref() }`,
])("NUXT0078 recognizes genuinely shadowed helpers: %s", async (source) => {
  const result = await runNuxt(noStatelessComposable, { "app/composables/useCounter.ts": source });
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0078"]);
});
