import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { asyncDataHandlerMustReturn } from "../../../src/rule-packs/nuxt/rules/nuxt/async-data-handler-must-return.ts";

async function run(files: Record<string, string>) {
  const result = await runProjectFixture({
    rules: [asyncDataHandlerMustReturn],
    framework: "nuxt",
    files,
  });
  return result.diagnostics;
}

const page = (script: string) =>
  `<script setup lang="ts">\n${script}\n</script>\n<template><div /></template>`;

describe("nuxt/fetch/handler-must-return", () => {
  test("reports a handler that only assigns a store", async () => {
    const diagnostics = await run({
      "app/pages/cart.vue": page(
        "const store = useCartStore()\nawait useAsyncData('cart', async () => {\n  store.items = await $fetch('/api/cart')\n})",
      ),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("NUXT0103");
    expect(diagnostics[0]?.severity).toBe("warn");
    expect(diagnostics[0]?.range?.line).toBe(3);
    expect(diagnostics[0]?.why).toContain("useAsyncData()");
    expect(diagnostics[0]?.why).toContain("NUXT_E3006");
    expect(diagnostics[0]?.suggestion).toContain("return null");
  });

  test("reports useLazyAsyncData without a key and handlers with a bare return", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page(
        "useLazyAsyncData(async function () {\n  await $fetch('/api/ping')\n}, { lazy: true })",
      ),
      "app/composables/useUser.ts":
        "import { useAsyncData } from '#app'\nexport function useUser(id: string) {\n  return useAsyncData(`user-${id}`, async () => {\n    if (!id) return\n    const items = [1].map((item) => { return item })\n    console.log(items)\n  })\n}\n",
    });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.why)).toEqual(
      expect.arrayContaining([expect.stringContaining("useLazyAsyncData()")]),
    );
  });

  test("resolves useAsyncData through the manifest's auto-imports", async () => {
    const manifest = (from: string) =>
      JSON.stringify({
        generatedAt: new Date(Date.now() + 10_000).toISOString(),
        nuxtVersion: "4.5.2",
        appDir: "app",
        autoImportEnabled: true,
        autoImports: [{ name: "useAsyncData", from, kind: "nuxt" }],
        components: [],
        layers: [],
      });
    const files = {
      "app/pages/a.vue": page("await useAsyncData('a', async () => { await load() })"),
    };

    const nuxt = await run({
      ".nuxt/doctor.manifest.json": manifest("#app/composables/asyncData"),
      ...files,
    });
    const other = await run({ ".nuxt/doctor.manifest.json": manifest("~/utils/data"), ...files });

    expect(nuxt).toHaveLength(1);
    expect(other).toEqual([]);
  });

  test("stays quiet for handlers that return a value", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page(
        [
          "await useAsyncData('a', () => $fetch('/api/a'))",
          "await useAsyncData('b', async () => { const b = await $fetch('/api/b'); return b })",
          "await useAsyncData('c', async () => { if (!ok) return null; return 1 })",
          "await useAsyncData('d', () => { throw createError({ statusCode: 404 }) })",
          "await useFetch('/api/e')",
        ].join("\n"),
      ),
    });

    expect(diagnostics).toEqual([]);
  });

  test("distinguishes alias-only reactive and keyless handlers from non-SSR calls and rejections", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page(
        [
          "import { useAsyncData as loadData, useLazyAsyncData as lazyData } from '#app'",
          "loadData(() => 'user-' + id.value, async () => { await load() })",
          "lazyData(async () => { await load() })",
          "if (import.meta.client && ready) loadData('client', () => {})",
          "onMounted(() => loadData('mounted', () => {}))",
          "loadData('disabled', () => {}, { enabled: false })",
          "loadData('reject', () => { if (flag.value) throw new Error('A'); else throw new Error('B') })",
          "loadData('fallthrough', () => { if (flag.value) throw new Error('A') })",
        ].join("\n"),
      ),
    });
    expect(diagnostics.map(({ range }) => range?.line)).toEqual([3, 4, 9]);
  });

  test("stays quiet when options replace the result or keep the handler off the server", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page(
        [
          "await useAsyncData('a', async () => { await load() }, { default: () => [] })",
          "await useAsyncData('b', async () => { await load() }, { transform: () => [] })",
          "await useAsyncData('c', async () => { await load() }, { server: false })",
          "await useAsyncData('d', async () => { await load() }, { immediate: false })",
          "await useAsyncData('e', async () => { await load() }, { getCachedData: () => [] })",
        ].join("\n"),
      ),
      "app/components/Live.client.vue": page(
        "await useAsyncData('f', async () => { await load() })",
      ),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet for options or handlers it cannot read and for a shadowed useAsyncData", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page(
        [
          "const options = { default: () => [] }",
          "await useAsyncData('a', async () => { await load() }, options)",
          "await useAsyncData('b', async () => { await load() }, { ...options })",
          "const handler = async () => { await load() }",
          "await useAsyncData('c', handler)",
        ].join("\n"),
      ),
      "app/pages/b.vue": page(
        "import { useAsyncData } from '~/utils/data'\nawait useAsyncData('d', async () => { await load() })",
      ),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet when the app disables SSR", async () => {
    const diagnostics = await run({
      "nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })\n",
      "app/pages/a.vue": page("await useAsyncData('a', async () => { await load() })"),
    });

    expect(diagnostics).toEqual([]);
  });
});
