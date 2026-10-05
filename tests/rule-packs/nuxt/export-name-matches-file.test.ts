import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.js";
import nuxtRulePack, {
  exportNameMatchesFile,
} from "../../../src/rule-packs/nuxt/rules/nuxt/index.js";
import { getRuleDocuments, rulesCollectionSource } from "../../../docs/rules/source.js";

const ruleId = "nuxt/composables/export-name-matches-file";

function runNuxt(files: Record<string, string>, dependencies?: Record<string, string>) {
  return runRuleFixture({ rule: exportNameMatchesFile, framework: "nuxt", files, dependencies });
}

async function codes(files: Record<string, string>) {
  return (await runNuxt(files)).diagnostics.map((diagnostic) => diagnostic.code);
}

test("is a Strict-only rule documented with a strict run command", async () => {
  expect(nuxtRulePack.presets.recommended).not.toContain(ruleId);
  expect(nuxtRulePack.presets.strict).toContain(ruleId);
  const document = getRuleDocuments().find((rule) => rule.id === ruleId)!;
  expect(document.diagnosticCodes).toEqual(["NUXT0079", "NUXT0080"]);
  expect(await rulesCollectionSource.getItem(document.key)).toContain(
    `pnpm nuxt doctor --extends auto,nuxt/strict --rules ${ruleId}`,
  );
});

test.each([
  ["useCart.ts", `export function useShoppingCart() { return useState('cart') }`],
  ["use-cart.ts", `export const useShoppingCart = () => useState('cart')`],
  ["use_cart.ts", `export function useCartItems() {}\nexport function useCartTotal() {}`],
  ["useCart.ts", `function useCartState() {}\nexport { useCartState }`],
])("NUXT0079 reports %s without a matching named export", async (file, source) => {
  const result = await runNuxt({ [`app/composables/${file}`]: source });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ ruleId, code: "NUXT0079", severity: "info" });
  expect(result.diagnostics[0]!.why).toContain("useCart");
});

test.each([
  ["useCart.ts", `export function useCart() {}`],
  ["use-cart.ts", `export const useCart = () => useState('cart')`],
  [
    "useCart.ts",
    `export function useCart() {}\nexport function useCartTotal() {}\nexport const CART_KEY = 'cart'`,
  ],
  ["useCart.ts", `export { useCart } from './cart/useCart'`],
  ["useCart.ts", `export const [useProvideCart, useCart] = createInjectionState(() => ref([]))`],
  ["useCart.ts", `export default function () { return useState('cart') }`],
  ["useCart.ts", `export * from './cart'`],
  ["useCart.ts", `export function cartState() { onMounted(() => {}) }`],
  [
    "useCart.ts",
    `export type CartItem = { id: string }\nexport interface Cart { items: CartItem[] }`,
  ],
  [
    "states.ts",
    `export const useColor = () => useState('color')\nexport const useCounter = () => useState('counter')`,
  ],
  ["index.ts", `export function useThing() {}`],
])("NUXT0079 ignores composables/%s when names match or are out of scope", async (file, source) => {
  expect(await codes({ [`app/composables/${file}`]: source })).toEqual([]);
});

test("NUXT0079 explains exports that differ from the file name only in casing", async () => {
  const result = await runNuxt({
    "app/composables/usePosthogAuth.ts": `export const helper = 1\nexport function usePostHogAuth() {}`,
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.why).toContain("usePostHogAuth, which differs only in casing");
  expect(result.diagnostics[0]!.range?.line).toBe(2);
});

test("NUXT0079 ignores nested files that Nuxt does not scan", async () => {
  expect(
    await codes({ "app/composables/cart/useCart.ts": `export function useShoppingCart() {}` }),
  ).toEqual([]);
});

test.each([
  ["fetch-user.ts", "fetchUser"],
  ["fetchUser.ts", "fetchUser"],
  ["UseCart.ts", "UseCart"],
  ["user.ts", "user"],
])("NUXT0080 reports default exports in composables/%s auto-imported as %s", async (file, name) => {
  const result = await runNuxt({
    [`app/composables/${file}`]: `export default function () {\n  return useFetch('/api/user')\n}`,
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ ruleId, code: "NUXT0080", severity: "info" });
  expect(result.diagnostics[0]!.why).toContain(`as ${name},`);
});

test.each([
  ["named default specifiers", `function load() {}\nexport { load as default }`],
  ["default values", `export default createSharedComposable(() => useMouse())`],
])("NUXT0080 reports %s", async (_label, source) => {
  expect(await codes({ "app/composables/mouse.ts": source })).toEqual(["NUXT0080"]);
});

test.each([
  ["use-user.ts", `export default function () { return useFetch('/api/user') }`],
  ["useUser.ts", `export default () => useFetch('/api/user')`],
  ["use_user.ts", `export default function fetchUser() {}`],
  ["index.ts", `export default function () {}`],
  ["fetch-user.d.ts", `export default function fetchUser(): void`],
])("NUXT0080 ignores composables/%s", async (file, source) => {
  expect(await codes({ [`app/composables/${file}`]: source })).toEqual([]);
});

test("NUXT0080 resolves Nuxt 3 root composables and ignores utils", async () => {
  const result = await runRuleFixture({
    rule: exportNameMatchesFile,
    framework: "nuxt",
    dependencies: { nuxt: "^3.15.0" },
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})",
      "composables/fetch-user.ts": `export default function () {}`,
      "utils/fetch-user.ts": `export default function () {}`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
    expect.stringMatching(/\/composables\/fetch-user\.ts$/),
  ]);
});
