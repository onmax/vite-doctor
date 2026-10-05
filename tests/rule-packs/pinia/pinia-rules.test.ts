import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { describe, expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  piniaRulePack,
  storeNameMatchesId,
  uniqueStoreId,
} from "../../../src/rule-packs/pinia/index.ts";
import { expectedStoreName } from "../../../src/rule-packs/pinia/rules/shared.ts";
import {
  diagnosticsCollectionSource,
  getDiagnosticDocuments,
  getRuleDocuments,
  rulesCollectionSource,
} from "../../../docs/rules/source.ts";

const pinia = { pinia: "^3.0.0" };

function duplicates(files: Record<string, string>) {
  return runProjectFixture({ dependencies: pinia, rules: [uniqueStoreId], files });
}

function names(files: Record<string, string>) {
  return runProjectFixture({ dependencies: pinia, rules: [storeNameMatchesId], files });
}

describe("pinia/stores/unique-store-id", () => {
  test("reports every definition of a duplicated id and points at the other file", async () => {
    const result = await duplicates({
      "src/stores/cart.ts":
        "import { defineStore } from 'pinia'\nexport const useCartStore = defineStore('cart', () => ({}))\n",
      "src/stores/checkout.ts":
        "import { defineStore } from 'pinia'\nexport const useCheckoutStore = defineStore('cart', {\n  state: () => ({ step: 1 }),\n})\n",
    });

    expect(result.diagnostics).toHaveLength(2);
    const [cart, checkout] = result.diagnostics.toSorted((a, b) => a.file.localeCompare(b.file));
    expect(cart).toMatchObject({
      code: "PINIA0001",
      ruleId: "pinia/stores/unique-store-id",
      severity: "error",
      range: { line: 2, column: 41 },
    });
    expect(cart!.file.endsWith("src/stores/cart.ts")).toBe(true);
    expect(cart!.why).toContain("src/stores/checkout.ts:2:");
    expect(cart!.related).toEqual([
      expect.objectContaining({ file: checkout!.file, range: checkout!.range }),
    ]);
    expect(cart!.diagnostic.sources).toEqual([
      "src/stores/cart.ts:2:41",
      `src/stores/checkout.ts:${checkout!.range!.line}:${checkout!.range!.column}`,
    ]);
    expect(checkout!.why).toContain("src/stores/cart.ts:2:41");
    expect(checkout!.diagnostic.fix).toContain('store "cart"');
  });

  test("compares the object form id with the string form", async () => {
    const result = await duplicates({
      "src/stores/a.js":
        "import { defineStore } from 'pinia'\nexport const useCartStore = defineStore({ id: 'cart', state: () => ({}) })\n",
      "src/stores/b.js":
        "import { defineStore } from 'pinia'\nexport const useOtherStore = defineStore(`cart`, () => ({}))\n",
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "PINIA0001",
      "PINIA0001",
    ]);
  });

  test("recognizes auto-imported, aliased, namespace, and SFC definitions", async () => {
    const result = await duplicates({
      "stores/auto.ts": "export const useUserStore = defineStore('user', () => ({}))\n",
      "stores/alias.ts":
        "import { defineStore as store } from 'pinia'\nexport const useUser = store('user', {})\n",
      "stores/namespace.ts":
        "import * as Pinia from 'pinia'\nexport const useUser2 = Pinia.defineStore('user', {})\n",
      "components/Inline.vue":
        "<script lang=\"ts\">\nimport { defineStore } from 'pinia'\nexport const useInline = defineStore('user', {})\n</script>\n<template><div /></template>\n",
    });
    expect(result.diagnostics).toHaveLength(4);
    expect(result.diagnostics.every((diagnostic) => diagnostic.related?.length === 3)).toBe(true);
  });

  test("ignores unique, dynamic, and non-Pinia ids", async () => {
    const result = await duplicates({
      "src/stores/cart.ts":
        "import { defineStore } from 'pinia'\nexport const useCartStore = defineStore('cart', () => ({}))\n",
      "src/stores/checkout.ts":
        "import { defineStore } from 'pinia'\nexport const useCheckoutStore = defineStore('checkout', () => ({}))\n",
      "src/stores/dynamic.ts":
        "import { defineStore } from 'pinia'\nconst id = 'cart'\nexport const a = defineStore(id, () => ({}))\nexport const b = (name: string) => defineStore(`cart-${name}`, () => ({}))()\n",
      "src/other/local.ts":
        "import { defineStore } from './define-store'\nexport const fake = defineStore('cart', {})\n",
      "src/other/declared.ts":
        "function defineStore(id: string, value: unknown) { return value }\nexport const fake = defineStore('cart', {})\n",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("ignores test, fixture, and spec files", async () => {
    const result = await duplicates({
      "src/stores/cart.ts":
        "import { defineStore } from 'pinia'\nexport const useCartStore = defineStore('cart', () => ({}))\n",
      "tests/cart.ts":
        "import { defineStore } from 'pinia'\nexport const useMock = defineStore('cart', () => ({}))\n",
      "src/fixtures/cart.ts":
        "import { defineStore } from 'pinia'\nexport const useFixture = defineStore('cart', () => ({}))\n",
      "src/stores/cart.spec.ts":
        "import { defineStore } from 'pinia'\nexport const useSpec = defineStore('cart', () => ({}))\n",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("compares stores only within the same workspace package", async () => {
    const result = await duplicates({
      "apps/web/package.json": "{}",
      "apps/web/stores/user.ts":
        "import { defineStore } from 'pinia'\nexport const useUserStore = defineStore('user', () => ({}))\n",
      "apps/admin/package.json": "{}",
      "apps/admin/stores/user.ts":
        "import { defineStore } from 'pinia'\nexport const useUserStore = defineStore('user', () => ({}))\n",
      "apps/admin/stores/session.ts":
        "import { defineStore } from 'pinia'\nexport const useSessionStore = defineStore('user', () => ({}))\n",
    });
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.file.split("/apps/")[1]).sort(),
    ).toEqual(["admin/stores/session.ts", "admin/stores/user.ts"]);
  });
});

describe("pinia/stores/store-name-matches-id", () => {
  test("reports a composable name that does not match the id", async () => {
    const result = await names({
      "src/stores/cart.ts":
        "import { defineStore } from 'pinia'\nexport const useBasket = defineStore('cart', () => ({}))\n",
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "PINIA0002",
        ruleId: "pinia/stores/store-name-matches-id",
        severity: "info",
        range: expect.objectContaining({ line: 2, column: 14 }),
      }),
    ]);
    expect(result.diagnostics[0]!.diagnostic.fix).toContain('"useCartStore"');
  });

  test("reads options, setup, and object-form definitions", async () => {
    const result = await names({
      "src/stores/a.ts":
        "import { defineStore } from 'pinia'\nexport const useA = defineStore({ id: 'cart', state: () => ({}) })\nexport const useB = defineStore('cart', { state: () => ({}) })\nexport const useC = defineStore('cart', () => ({}))\n",
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.range?.line)).toEqual([2, 3, 4]);
  });

  test("accepts conventional names for kebab, snake, camel, and Store-suffixed ids", async () => {
    const result = await names({
      "src/stores/names.ts": [
        "import { defineStore } from 'pinia'",
        "export const useCartStore = defineStore('cart', () => ({}))",
        "export const useShoppingCartStore = defineStore('shopping-cart', () => ({}))",
        "export const useUserSettingsStore = defineStore('user_settings', () => ({}))",
        "export const useAuthSessionStore = defineStore('authSession', () => ({}))",
        "export const useUIStore = defineStore('ui', () => ({}))",
        "export const useProfileStore = defineStore('profileStore', () => ({}))",
        "export const useTypedStore = defineStore('typed', () => ({})) as unknown",
      ].join("\n"),
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("skips dynamic ids, unbound calls, and non-Pinia defineStore", async () => {
    const result = await names({
      "src/stores/skip.ts":
        "import { defineStore } from 'pinia'\nconst id = 'cart'\nexport const useBasket = defineStore(id, () => ({}))\nexport const useDynamic = defineStore(`cart-${id}`, () => ({}))\nexport default defineStore('cart', () => ({}))\n",
      "src/other/local.ts":
        "import { defineStore } from './local-store'\nexport const useBasket = defineStore('cart', {})\n",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("derives the conventional name from the id", () => {
    expect(expectedStoreName("cart")).toBe("useCartStore");
    expect(expectedStoreName("shopping-cart")).toBe("useShoppingCartStore");
    expect(expectedStoreName("shoppingCart")).toBe("useShoppingCartStore");
    expect(expectedStoreName("user_settings")).toBe("useUserSettingsStore");
    expect(expectedStoreName("cartStore")).toBe("useCartStore");
  });
});

describe("pinia rule pack", () => {
  test("activates for pinia and @pinia/nuxt with composed presets", () => {
    expect(piniaRulePack.name).toBe("vite-doctor/pinia");
    expect(piniaRulePack.activation).toEqual({ packages: ["pinia", "@pinia/nuxt"] });
    expect(piniaRulePack.presets.recommended).not.toContain(storeNameMatchesId.meta.id);
    expect(piniaRulePack.presets).toEqual({
      recommended: ["pinia/stores/unique-store-id"],
      strict: ["pinia/stores/unique-store-id", "pinia/stores/store-name-matches-id"],
    });
  });

  test("runs through the Vite Doctor distribution only for Pinia projects", async () => {
    const files = {
      "src/stores/cart.ts":
        "import { defineStore } from 'pinia'\nexport const useBasket = defineStore('cart', () => ({}))\n",
      "src/stores/checkout.ts":
        "import { defineStore } from 'pinia'\nexport const useCheckoutStore = defineStore('cart', () => ({}))\n",
    };
    const piniaCodes = (result: { diagnostics: Array<{ code: string }> }) =>
      result.diagnostics
        .map((diagnostic) => diagnostic.code)
        .filter((code) => code.startsWith("PINIA"))
        .sort();

    await withProject({ vue: "^3.5.0", pinia: "^3.0.0" }, files, async (root) => {
      const recommended = await runViteDoctor({ root, framework: "vue", cache: false });
      expect(piniaCodes(recommended)).toEqual(["PINIA0001", "PINIA0001"]);
      const strict = await runViteDoctor({
        root,
        framework: "vue",
        cache: false,
        extends: ["auto", "pinia/strict"],
      });
      expect(piniaCodes(strict)).toEqual(["PINIA0001", "PINIA0001", "PINIA0002", "PINIA0002"]);
    });

    await withProject({ nuxt: "^4.0.0", "@pinia/nuxt": "^0.11.0" }, files, async (root) => {
      const nuxt = await runViteDoctor({ root, framework: "nuxt", cache: false });
      expect(piniaCodes(nuxt)).toEqual(["PINIA0001", "PINIA0001"]);
    });

    await withProject({ vue: "^3.5.0" }, files, async (root) => {
      const withoutPinia = await runViteDoctor({ root, framework: "vue", cache: false });
      expect(piniaCodes(withoutPinia)).toEqual([]);
    });
  });

  test("documents every rule and diagnostic code", async () => {
    const documents = getRuleDocuments().filter((rule) => rule.framework === "pinia");
    expect(documents.map((rule) => [rule.id, rule.path, rule.diagnosticCodes])).toEqual([
      [
        "pinia/stores/store-name-matches-id",
        "/pinia/rules/stores/store-name-matches-id",
        ["PINIA0002"],
      ],
      ["pinia/stores/unique-store-id", "/pinia/rules/stores/unique-store-id", ["PINIA0001"]],
    ]);
    const page = await rulesCollectionSource.getItem(documents[1]!.key);
    expect(page).toContain("defineStore('checkout'");
    const diagnosticPages = getDiagnosticDocuments().filter((diagnostic) =>
      diagnostic.code.startsWith("PINIA"),
    );
    expect(
      await Promise.all(
        diagnosticPages.map((diagnostic) => diagnosticsCollectionSource.getItem(diagnostic.key)),
      ),
    ).toEqual([
      expect.stringContaining(
        "pnpm vite-doctor . --extends auto,pinia/strict --rules pinia/stores/store-name-matches-id",
      ),
      expect.stringContaining("pnpm vite-doctor . --rules pinia/stores/unique-store-id"),
    ]);
    expect(
      getDiagnosticDocuments()
        .filter((diagnostic) => diagnostic.code.startsWith("PINIA"))
        .map((diagnostic) => [diagnostic.code, diagnostic.rulePath]),
    ).toEqual([
      ["PINIA0002", "/pinia/rules/stores/store-name-matches-id"],
      ["PINIA0001", "/pinia/rules/stores/unique-store-id"],
    ]);
  });
});

async function withProject(
  dependencies: Record<string, string>,
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "vite-doctor-pinia-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", dependencies }));
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
