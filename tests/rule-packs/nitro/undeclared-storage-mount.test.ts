import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { nitroRulePack, noUndeclaredStorageMount } from "../../../src/rule-packs/nitro/index.ts";
import type { NitroStorageInventory } from "../../../src/rule-packs/nitro/rules/storage-mounts.ts";

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
  include?: string[],
) {
  const result = await runProjectFixture({
    rules: [noUndeclaredStorageMount],
    framework,
    dependencies,
    files,
    config: include ? { include } : undefined,
  });
  return {
    diagnostics: result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
      line: diagnostic.range?.line,
    })),
    inventory: result.project.inventory?.nitroStorage as NitroStorageInventory | undefined,
  };
}

const handler = `export default defineEventHandler(async () => {
  const sessions = useStorage('redis')
  const counts = useStorage('redis:counters')
  const docs = useStorage('content')
  const assets = useStorage('assets:server')
  return [await sessions.getKeys(), await counts.getItem('hits'), await docs.getKeys(), await assets.getKeys()]
})
`;

test("is a Strict-only Nitro rule", () => {
  expect(nitroRulePack.presets.strict).toContain(noUndeclaredStorageMount.meta.id);
  expect(nitroRulePack.presets.recommended).not.toContain(noUndeclaredStorageMount.meta.id);
});

test("reports bases with no production mount and records the mounts", async () => {
  const { diagnostics, inventory } = await run({
    "nuxt.config.ts": `export default defineNuxtConfig({
  nitro: {
    storage: { content: { driver: 'fs', base: './content' } },
    devStorage: { redis: { driver: 'fs', base: './.data/redis' } },
  },
})
`,
    "server/api/stats.get.ts": handler,
  });
  expect(diagnostics).toEqual([
    { code: "NITRO0034", file: "server/api/stats.get.ts", line: 2 },
    { code: "NITRO0034", file: "server/api/stats.get.ts", line: 3 },
  ]);
  expect(inventory).toMatchObject({
    complete: true,
    mounts: expect.arrayContaining([
      expect.objectContaining({ base: "content", source: "storage" }),
      expect.objectContaining({ base: "redis", source: "devStorage" }),
      expect.objectContaining({ base: "assets", source: "builtin" }),
    ]),
  });
});

test("reads Nitro 3 kv mounts from nitro.config", async () => {
  const { diagnostics } = await run(
    {
      "nitro.config.ts": `import { defineConfig } from "nitro"

export default defineConfig({
  serverDir: "./server",
  kv: { redis: { driver: "redis", url: "redis://localhost" } },
})
`,
      "server/routes/stats.ts": `import { defineHandler } from "nitro/h3"
import { useStorage } from "nitro/storage"

export default defineHandler(async () => {
  await useStorage("redis").setItem("hits", 1)
  return useStorage("sessions").getKeys()
})
`,
    },
    "nitro",
    { nitro: "^3.0.0" },
  );
  expect(diagnostics).toEqual([{ code: "NITRO0034", file: "server/routes/stats.ts", line: 6 }]);
});

test("stays quiet when every base is declared", async () => {
  const { diagnostics } = await run({
    "nuxt.config.ts": `export default defineNuxtConfig({
  nitro: {
    storage: {
      redis: { driver: 'redis' },
      content: { driver: 'fs', base: './content' },
    },
  },
})
`,
    "server/api/stats.get.ts": handler,
  });
  expect(diagnostics).toEqual([]);
});

test.each([
  [
    "a plugin that mounts storage at runtime",
    {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "server/plugins/storage.ts":
        "import redisDriver from 'unstorage/drivers/redis'\n\nexport default defineNitroPlugin(() => {\n  useStorage().mount('redis', redisDriver({}))\n})\n",
    },
  ],
  [
    "storage read from a variable",
    {
      "nuxt.config.ts":
        "const storage = { redis: { driver: 'redis' } }\nexport default defineNuxtConfig({ nitro: { storage } })\n",
    },
  ],
  [
    "environment overrides",
    {
      "nuxt.config.ts":
        "export default defineNuxtConfig({ $production: { nitro: { storage: { redis: { driver: 'redis' } } } } })\n",
    },
  ],
  [
    "a Nuxt module that configures storage",
    {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-kv'] })\n",
      "node_modules/nuxt-kv/package.json": '{ "name": "nuxt-kv", "version": "1.0.0" }',
      "node_modules/nuxt-kv/dist/module.mjs":
        "export default defineNuxtModule({ setup(_, nuxt) { nuxt.options.nitro.storage.redis = { driver: 'redis' } } })\n",
    },
  ],
  [
    "a Nuxt module that is not installed",
    { "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['missing-module'] })\n" },
  ],
  [
    "a Nuxt layer",
    { "nuxt.config.ts": "export default defineNuxtConfig({ extends: ['../base'] })\n" },
  ],
] as const)("stays quiet with %s", async (_, files) => {
  const { diagnostics, inventory } = await run({ ...files, "server/api/stats.get.ts": handler });
  expect(diagnostics).toEqual([]);
  expect(inventory?.complete).toBe(false);
});

test("reports when the installed Nuxt modules leave storage alone", async () => {
  const { diagnostics } = await run({
    "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@acme/ui'] })\n",
    "node_modules/@acme/ui/package.json": '{ "name": "@acme/ui", "version": "1.0.0" }',
    "node_modules/@acme/ui/dist/module.mjs":
      "export default defineNuxtModule({ setup(_, nuxt) { nuxt.options.css.push('@acme/ui/style.css') } })\n",
    "server/api/stats.get.ts":
      "export default defineEventHandler(() => useStorage('redis').getKeys())\n",
  });
  expect(diagnostics).toEqual([{ code: "NITRO0034", file: "server/api/stats.get.ts", line: 1 }]);
});

test("stays quiet for built-in bases, dynamic bases, and local useStorage", async () => {
  const { diagnostics } = await run({
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "server/api/stats.get.ts": `import { useStorage as useBrowserStorage } from '@vueuse/core'

export default defineEventHandler(async (event) => {
  const base = getRouterParam(event, 'base')
  return [
    await useStorage('data').getKeys(),
    await useStorage('assets:nitro').getKeys(),
    await useStorage().getKeys(),
    await useStorage(base).getKeys(),
    useBrowserStorage('redis', 0),
  ]
})
`,
  });
  expect(diagnostics).toEqual([]);
});

const sessionsRoute = "export default () => useStorage('sessions').getKeys()";

test.each([
  { ".nitrorc": "storage.sessions.driver=memory" },
  { "nitro.config.ts": "export default { extends: ['./layer'] }" },
  {
    "nitro.config.ts": "export default { plugins: ['./extras/storage'] }",
    "extras/storage.ts": "export default () => useStorage()['mount']('sessions', driver)",
  },
])("marks opaque Nitro config and plugins incomplete: %j", async (files) => {
  const result = await run(
    {
      ...Object.fromEntries(Object.entries(files).filter(([, contents]) => contents !== undefined)),
      "routes/track.ts": sessionsRoute,
    },
    "nitro",
    { nitropack: "^2.13.4" },
  );
  expect(result.inventory?.complete).toBe(false);
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "{ hooks: { 'nitro:config': config => { config.storage = mounts } } }",
  "{ nitro: { modules: ['./modules/storage'] } }",
])("marks unresolved Nuxt contributors incomplete: %s", async (config) => {
  const result = await run({
    "nuxt.config.ts": `export default ${config}`,
    "server/routes/track.ts": sessionsRoute,
  });
  expect(result.inventory?.complete).toBe(false);
  expect(result.diagnostics).toEqual([]);
});

test("marks auto-scanned Nitro 3 modules incomplete", async () => {
  const result = await run(
    {
      "nitro.config.ts": "export default { serverDir: './server' }",
      "server/routes/track.ts": sessionsRoute,
      "modules/storage.ts": "export default nitro => { nitro.options.kv = mounts }",
    },
    "nitro",
    { nitro: "^3.0.0" },
  );
  expect(result.inventory?.complete).toBe(false);
  expect(result.diagnostics).toEqual([]);
});

test("scans runtime mounts independently of include", async () => {
  const result = await run(
    {
      "server/api/track.ts": sessionsRoute,
      "server/plugins/storage.ts": "const store = useStorage(); store['mount']('sessions', driver)",
    },
    "nuxt",
    undefined,
    ["server/api/**"],
  );
  expect(result.inventory?.complete).toBe(false);
  expect(result.diagnostics).toEqual([]);
});

test("inspects a registered Nitro 2 plugin relative to srcDir", async () => {
  const result = await run(
    {
      "nitro.config.ts": "export default { srcDir: './src', plugins: ['./extras/storage'] }",
      "src/api/track.ts": sessionsRoute,
      "src/extras/storage.ts": "export default () => console.log('ready')",
      "extras/storage.ts": "export default () => useStorage().mount('sessions', driver)",
    },
    "nitro",
    { nitropack: "^2.13.4" },
    ["src/api/**"],
  );
  expect(result.inventory?.complete).toBe(true);
  expect(result.diagnostics).toHaveLength(1);
});

test("ignores comments and Vue mounts and skips only dev routes", async () => {
  const result = await run(
    {
      "client.ts": "// useStorage().mount('sessions', driver)\ncreateApp({}).mount('#app')",
      "routes/track.dev.ts": sessionsRoute,
      "routes/track.prod.ts": sessionsRoute,
      "utils/read.dev.ts": sessionsRoute,
    },
    "nitro",
    { nitropack: "^2.13.4" },
  );
  expect(result.inventory?.complete).toBe(true);
  expect(result.diagnostics.map(({ file }) => file).sort()).toEqual([
    "routes/track.prod.ts",
    "utils/read.dev.ts",
  ]);
});

test("uses Nitro 2 production mounts, not kv or dev-only defaults", async () => {
  const result = await run(
    {
      "nitro.config.ts":
        "export default { preset: 'cloudflare-module', kv: { sessions: { driver: 'memory' } }, bundledStorage: ['snapshot'] }",
      "routes/track.ts": `useStorage('sessions').getKeys()
useStorage('root').getItem('file')
useStorage('cache').getItem('response')
useStorage('data').getItem('record')
useStorage('snapshot').getItem('seed')`,
    },
    "nitro",
    { nitropack: "^2.13.4" },
  );
  expect(result.diagnostics.map(({ line }) => line)).toEqual([1, 2, 3, 4]);
});

test("Nitro 3 does not mount data by default", async () => {
  const result = await run(
    {
      "nitro.config.ts": "export default { scanDirs: ['./server'] }",
      "server/routes/track.ts":
        "import { useKV } from 'nitro/kv'; export default () => useKV('data').setItem('x', 1)",
    },
    "nitro",
    { nitro: "^3.0.0" },
  );
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["deno-server", "", true],
  ["vercel-edge", "", false],
  ["node-server", ", node: false", false],
])("uses Nitro 2's effective node option for %s%s", async (preset, node, mounted) => {
  const result = await run(
    {
      "nitro.config.ts": `export default { preset: '${preset}'${node} }`,
      "routes/track.ts": "export default () => useStorage('data').getItem('record')",
    },
    "nitro",
    { nitropack: "^2.13.4" },
  );
  expect(
    result.inventory?.mounts.some(({ base, source }) => base === "data" && source === "builtin"),
  ).toBe(mounted);
  expect(result.diagnostics).toHaveLength(mounted ? 0 : 1);
});

test("a child mount covers matching item keys and supports listing, not sibling keys", async () => {
  const result = await run({
    "nuxt.config.ts":
      "export default { nitro: { storage: { 'sessions:archive': { driver: 'memory' } } } }",
    "server/routes/track.ts": `useStorage('sessions').setItem('live:alice', 1)
useStorage('sessions').getItem('archive/alice')
useStorage('sessions').getKeys()
const store = useStorage('sessions')
store['getItem']('live:bob')
useStorage('sessions').getItem('archive')`,
  });
  expect(result.diagnostics.map(({ line }) => line)).toEqual([1, 4, 6]);
});

test("an explicit root mount covers otherwise undeclared bases", async () => {
  const result = await run({
    "nuxt.config.ts":
      "export default { nitro: { storage: { '/': { driver: 'fs', base: './data' } } } }",
    "server/routes/track.ts": sessionsRoute,
  });
  expect(result.inventory?.mounts).toContainEqual({
    base: "",
    source: "storage",
    file: "nuxt.config.ts",
  });
  expect(result.diagnostics).toEqual([]);
});

test("checks item keys through asserted storage calls and reports each call once", async () => {
  const result = await run({
    "nuxt.config.ts":
      "export default { nitro: { storage: { 'sessions:archive': { driver: 'memory' } } } }",
    "server/routes/track.ts": `export default defineEventHandler(() => {
  const store = useStorage('sessions') as Storage
  store.getItem('live:alice')
  ;(useStorage('sessions') as Storage).getItem('live:bob')
  return (useStorage('sessions') as Storage).getItem('archive/alice')
})`,
  });
  expect(result.diagnostics).toEqual([
    { code: "NITRO0034", file: "server/routes/track.ts", line: 2 },
    { code: "NITRO0034", file: "server/routes/track.ts", line: 4 },
  ]);
});
