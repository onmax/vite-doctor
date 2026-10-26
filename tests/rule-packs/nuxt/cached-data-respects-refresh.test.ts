import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import nuxtRulePack from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { cachedDataRespectsRefresh } from "../../../src/rule-packs/nuxt/rules/nuxt/cached-data-respects-refresh.ts";

const SNIPPET = "(key, nuxtApp) => nuxtApp.payload.data[key] ?? nuxtApp.static.data[key]";

function nuxtPackage(version: string) {
  return { "node_modules/nuxt/package.json": JSON.stringify({ name: "nuxt", version }) };
}

function manifest(granularCachedData: boolean) {
  return JSON.stringify({
    generatedAt: new Date(Date.now() + 60_000).toISOString(),
    nuxtVersion: "4.5.2",
    vueVersion: "3.5.0",
    rootDir: ".",
    srcDir: "app",
    appDir: "app",
    buildDir: ".nuxt",
    autoImports: [],
    components: [],
    modules: [],
    layers: [{ root: ".", srcDir: "app", priority: 0 }],
    aliases: {},
    routeRules: {},
    serverHandlers: [],
    granularCachedData,
  });
}

async function run(files: Record<string, string>, version: string | null = "4.5.2") {
  // No runtime target, so the installed Nuxt package decides the version gates.
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [cachedDataRespectsRefresh],
    files: { ...(version ? nuxtPackage(version) : {}), ...files },
    run: { runtimeTarget: {} },
  });
  // Unresolved runtimes add DOC0022 Run diagnostics, which are not this Rule's.
  return result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0092");
}

function page(script: string) {
  return { "app/pages/orders.vue": `<script setup lang="ts">\n${script}\n</script>\n` };
}

test("reports the Nuxt 3 getCachedData snippet on a call that destructures refresh", async () => {
  const diagnostics = await run(
    page(`const { data, refresh } = await useFetch('/api/orders', {
  getCachedData: ${SNIPPET},
})`),
  );

  expect(diagnostics).toHaveLength(1);
  const [diagnostic] = diagnostics;
  expect(diagnostic?.code).toBe("NUXT0092");
  expect(diagnostic?.ruleId).toBe("nuxt/fetch/cached-data-respects-refresh");
  expect(diagnostic?.severity).toBe("warn");
  expect(diagnostic?.confidence).toBe("heuristic-high");
  expect(diagnostic?.why).toContain("can return nuxtApp.payload.data[key]");
  expect(diagnostic?.why).toContain("This call exposes refresh()");
  expect(diagnostic?.suggestion).toContain("ctx.cause !== 'initial' && !nuxtApp.isHydrating");
  expect(diagnostic?.range?.line).toBe(3);
  expect(diagnostic?.evidence?.map((item) => item.summary)).toEqual([
    "Nuxt 4.5.2 enables experimental.granularCachedData by default and nuxt.config does not turn it off.",
    "getCachedData returns nuxtApp.payload.data[key] and never reads its third argument or nuxtApp.isHydrating.",
    "The useFetch() result's refresh is read, so the data is refreshed on demand.",
  ]);
});

test.each([
  [
    "a top-level binding passed with watch and a literal key",
    `const getCachedData = ${SNIPPET}
const page = ref(1)
const { data } = await useAsyncData('orders', () => $fetch('/api/orders', { query: { page: page.value } }), {
  watch: [page],
  getCachedData,
})`,
  ],
  [
    "a function declaration on a handler-first useAsyncData with watch",
    `function getCachedData(key: string, nuxtApp: NuxtApp) {
  return nuxtApp.static.data[key] || nuxtApp.payload.data[key]
}
const { data } = await useAsyncData(() => $fetch('/api/orders'), { watch: [locale], getCachedData })`,
  ],
  [
    "a key refreshed by refreshNuxtData",
    `const { data } = await useAsyncData('orders', () => $fetch('/api/orders'), {
  getCachedData: ${SNIPPET},
})
const reload = () => refreshNuxtData(['orders', 'totals'])`,
  ],
  [
    "a refreshNuxtData() that refreshes every key",
    `const { data } = await useFetch('/api/orders', { getCachedData: ${SNIPPET} })
onActivated(() => refreshNuxtData())`,
  ],
  [
    "execute read from the result object",
    `const orders = useLazyFetch('/api/orders', { getCachedData: ${SNIPPET} })
onMounted(() => orders.execute())`,
  ],
  [
    "a renamed execute and an unused third parameter",
    `const { execute: load } = useLazyAsyncData('orders', () => $fetch('/api/orders'), {
  getCachedData(key, nuxtApp, ctx) {
    return nuxtApp.payload.data[key]
  },
})`,
  ],
  [
    "an expiring cache read through a local",
    `const { data, refresh } = await useFetch('/api/orders', {
  getCachedData(key, nuxtApp) {
    const cached = nuxtApp.payload.data[key] || nuxtApp.static.data[key]
    if (!cached) return
    if (Date.now() - cached.fetchedAt > 60_000) return
    return cached
  },
})`,
  ],
  [
    "a useFetch with a literal key option and watch",
    `const { data } = await useFetch(() => \`/api/orders/\${id.value}\`, {
  key: 'orders',
  watch: [id],
  getCachedData: ${SNIPPET},
})`,
  ],
])("reports %s", async (_name, script) => {
  const diagnostics = await run(page(script));
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0092"]);
});

test("reports a createUseAsyncData factory whose composable is refreshed in the same file", async () => {
  const diagnostics = await run({
    "app/composables/orders.ts": `export const useCachedData = createUseAsyncData({
  getCachedData (key, nuxtApp) {
    return nuxtApp.payload.data[key] ?? nuxtApp.static.data[key]
  },
})

export function useOrders() {
  const { data, refresh } = useCachedData('orders', () => $fetch('/api/orders'))
  return { orders: data, reload: refresh }
}`,
  });

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.why).toContain(
    "the useCachedData() composable created by createUseAsyncData()",
  );
  expect(diagnostics[0]?.why).toContain("The useCachedData() call on line 8 exposes refresh()");
});

test.each([
  ["a factory with no refreshed caller in the file", ""],
  [
    "a caller that passes its own getCachedData to a default-mode factory",
    "const { refresh } = useCachedData('orders', () => $fetch('/api/orders'), { getCachedData: () => undefined })",
  ],
])("does not report %s", async (_name, caller) => {
  const diagnostics = await run({
    "app/composables/orders.ts": `export const useCachedData = createUseAsyncData({
  getCachedData: ${SNIPPET},
})
${caller}`,
  });
  expect(diagnostics).toEqual([]);
});

test("reports an override-mode factory even when the caller passes getCachedData", async () => {
  const diagnostics = await run({
    "app/composables/orders.ts": `export const useCachedFetch = createUseFetch(() => ({
  getCachedData: ${SNIPPET},
}))
const { refresh } = useCachedFetch('/api/orders', { getCachedData: () => undefined })`,
  });
  expect(diagnostics).toHaveLength(1);
});

test.each([
  [
    "reads ctx.cause",
    `(key, nuxtApp, ctx) => ctx.cause === 'initial' ? nuxtApp.payload.data[key] : undefined`,
  ],
  [
    "destructures cause",
    `(key, nuxtApp, { cause }) => {
    if (cause !== 'initial' && !nuxtApp.isHydrating) return undefined
    return nuxtApp.payload.data[key] ?? nuxtApp.static.data[key]
  }`,
  ],
  [
    "mirrors Nuxt's default with isHydrating only",
    `(key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined`,
  ],
  ["reads a custom cache", `(key) => cache.get(key)`],
  ["forwards its arguments", `(...args) => readCache(...args)`],
])("does not report getCachedData that %s", async (_name, getCachedData) => {
  const diagnostics = await run(
    page(
      `const { data, refresh } = await useFetch('/api/orders', { getCachedData: ${getCachedData} })`,
    ),
  );
  expect(diagnostics).toEqual([]);
});

test.each([
  [
    "only data is used",
    `const { data } = await useFetch('/api/orders', { getCachedData: ${SNIPPET} })`,
  ],
  [
    "watch is false",
    `const { data } = await useAsyncData('orders', () => $fetch('/api/orders'), { watch: false, getCachedData: ${SNIPPET} })`,
  ],
  [
    "the watched source changes the useFetch key",
    `const { data } = await useFetch('/api/orders', { query: { page }, watch: [page], getCachedData: ${SNIPPET} })`,
  ],
  [
    "watch is passed with a computed useAsyncData key",
    `const { data } = await useAsyncData(() => \`orders-\${page.value}\`, () => $fetch('/api/orders'), { watch: [page], getCachedData: ${SNIPPET} })`,
  ],
  [
    "refreshNuxtData targets another key",
    `const { data } = await useAsyncData('orders', () => $fetch('/api/orders'), { getCachedData: ${SNIPPET} })
const reload = () => refreshNuxtData('totals')`,
  ],
  [
    "a spread after getCachedData can replace it",
    `const { refresh } = await useFetch('/api/orders', { getCachedData: ${SNIPPET}, ...options })`,
  ],
  [
    "getCachedData is imported",
    `import { getCachedData } from '~/utils/cache'
const { refresh } = await useFetch('/api/orders', { getCachedData })`,
  ],
])("does not report when %s", async (_name, script) => {
  expect(await run(page(script))).toEqual([]);
});

const refreshed = page(
  `const { data, refresh } = await useFetch('/api/orders', { getCachedData: ${SNIPPET} })`,
);

test.each([
  ["Nuxt 4 turns granularCachedData off", "4.5.2", "experimental: { granularCachedData: false },"],
  ["Nuxt 3.16 has no granularCachedData", "3.16.2", "experimental: { granularCachedData: true },"],
  ["Nuxt 3.17 runs without compatibilityVersion 4", "3.17.0", ""],
  ["Nuxt 3.19 sets compatibilityVersion 3", "3.19.0", "future: { compatibilityVersion: 3 },"],
  ["experimental is computed", "4.5.2", "experimental: sharedExperimental,"],
  ["a spread can set experimental", "4.5.2", "...shared,"],
  [
    "an environment override sets the flag",
    "4.5.2",
    "$production: { experimental: { granularCachedData: false } },",
  ],
])("stays silent when %s", async (_name, version, config) => {
  const diagnostics = await run(
    { ...refreshed, "nuxt.config.ts": `export default defineNuxtConfig({\n  ${config}\n})\n` },
    version,
  );
  expect(diagnostics).toEqual([]);
});

test("stays silent when the Nuxt version is unresolved and nuxt.config leaves the default", async () => {
  expect(await run(refreshed, null)).toEqual([]);
});

test.each([
  ["Nuxt 3.17 with compatibilityVersion 4", "3.17.0", "future: { compatibilityVersion: 4 },"],
  ["Nuxt 3.17 with the flag on", "3.17.0", "experimental: { granularCachedData: true },"],
  ["an explicit flag without a resolved Nuxt", null, "experimental: { granularCachedData: true },"],
])("reports %s", async (_name, version, config) => {
  const diagnostics = await run(
    { ...refreshed, "nuxt.config.ts": `export default defineNuxtConfig({\n  ${config}\n})\n` },
    version,
  );
  expect(diagnostics).toHaveLength(1);
});

test("the resolved flag from a current manifest wins over nuxt.config", async () => {
  const config = {
    "nuxt.config.ts":
      "export default defineNuxtConfig({ experimental: { granularCachedData: true } })\n",
  };
  expect(
    await run({ ...refreshed, ...config, ".nuxt/doctor.manifest.json": manifest(false) }),
  ).toEqual([]);

  const diagnostics = await run({
    ...refreshed,
    "nuxt.config.ts": "export default defineNuxtConfig({ experimental: sharedExperimental })\n",
    ".nuxt/doctor.manifest.json": manifest(true),
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.confidence).toBe("manifest-backed");
  expect(diagnostics[0]?.evidence?.[0]).toMatchObject({
    kind: "manifest",
    summary: "The resolved Nuxt config enables experimental.granularCachedData.",
  });
});

test("runs in the Recommended Preset", () => {
  expect(nuxtRulePack.presets.recommended).toContain(cachedDataRespectsRefresh.meta.id);
});

test.each([
  "function unrelated(orders) { orders.refresh() }",
  "{ const orders = other; orders.execute() }",
  "function unrelated() { if (true) { var orders = other }; orders.refresh() }",
  "try {} catch (orders) { orders.refresh() }",
])("ignores shadowed result references: %s", async (shadow) => {
  expect(
    await run(
      page(`const orders = useFetch('/api/orders', { getCachedData: ${SNIPPET} })
${shadow}`),
    ),
  ).toEqual([]);
});

test.each([
  "function unrelated(useCachedData) { const { refresh } = useCachedData(() => []) }",
  "{ const useCachedData = other; const { refresh } = useCachedData(() => []) }",
])("ignores shadowed factory references: %s", async (shadow) => {
  expect(
    await run(
      page(`const useCachedData = createUseAsyncData({ getCachedData: ${SNIPPET} })
${shadow}`),
    ),
  ).toEqual([]);
});

test.each(["function loadOrders() { return [] }", "const loadOrders = () => []"])(
  "preserves handler-binding caller overrides: %s",
  async (handler) => {
    expect(
      await run(
        page(`${handler}
const useCachedData = createUseAsyncData({ getCachedData: ${SNIPPET} })
const { refresh } = useCachedData(loadOrders, { getCachedData: () => undefined })`),
      ),
    ).toEqual([]);
  },
);

test("recognizes unshadowed result and factory references inside closures", async () => {
  expect(
    await run(
      page(`const useCachedData = createUseAsyncData({ getCachedData: ${SNIPPET} })
function load() {
  const orders = useCachedData('orders', () => [])
  return () => orders.refresh()
}`),
    ),
  ).toHaveLength(1);
});
