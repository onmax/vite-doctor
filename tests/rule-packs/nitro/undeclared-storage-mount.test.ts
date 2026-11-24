import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { nitroRulePack, noUndeclaredStorageMount } from "../../../src/rule-packs/nitro/index.ts";
import type { NitroStorageInventory } from "../../../src/rule-packs/nitro/rules/storage-mounts.ts";

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  const result = await runRuleFixture({
    rule: noUndeclaredStorageMount,
    framework,
    dependencies,
    files,
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
    await useStorage('cache:nitro').getKeys(),
    await useStorage().getKeys(),
    await useStorage(base).getKeys(),
    useBrowserStorage('redis', 0),
  ]
})
`,
  });
  expect(diagnostics).toEqual([]);
});
