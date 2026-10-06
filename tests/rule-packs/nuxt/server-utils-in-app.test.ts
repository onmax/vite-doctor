import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  noServerTypesInApp,
  noServerUtilsInApp,
} from "../../../src/rule-packs/nuxt/rules/nuxt/no-server-utils-in-app.ts";
import nuxtRulePack from "../../../src/rule-packs/nuxt/rules/nuxt.ts";

const serverUtils = {
  "server/utils/pricing.ts": "export const formatPrice = (cents: number) => String(cents)",
};

async function run(files: Record<string, string>, dependencies?: Record<string, string>) {
  const result = await runProjectFixture({
    framework: "nuxt",
    dependencies,
    files: { ...serverUtils, ...files },
    rules: [noServerUtilsInApp, noServerTypesInApp],
  });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: fixturePath(diagnostic.file),
    line: diagnostic.range?.line,
  }));
}

function fixturePath(file: string | undefined) {
  return file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, "");
}

test.each([
  [
    "app/components/PriceTag.vue",
    `<script setup lang="ts">\nimport { formatPrice } from '~~/server/utils/pricing'\n</script>`,
  ],
  [
    "app/components/PriceTag.vue",
    `<script setup lang="ts">\nimport { formatPrice } from '@@/server/utils/pricing'\n</script>`,
  ],
  ["app/composables/usePrice.ts", `import { formatPrice } from '../../server/utils/pricing'`],
  [
    "app/pages/index.vue",
    `<script setup lang="ts">\nconst { formatPrice } = await import('~~/server/utils/pricing')\n</script>`,
  ],
  ["app/utils/price.ts", `export { formatPrice } from '~~/server/utils/pricing'`],
  ["app/utils/price.ts", `export * from '~~/server/utils/pricing'`],
  ["app/plugins/db.ts", `import '~~/server/utils/pricing'`],
  ["app/utils/price.ts", `import { formatPrice, type Price } from '~~/server/utils/pricing'`],
  ["shared/utils/price.ts", `import { formatPrice } from '../../server/utils/pricing'`],
  ["app/utils/db.ts", `import { db } from '~~/server/database/client'`],
])("reports runtime server imports in %s: %s", async (file, source) => {
  const diagnostics = await run({ [file]: source });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "NUXT0075", file });
});

test("points at the import source inside a Vue SFC", async () => {
  const diagnostics = await run({
    "app/components/PriceTag.vue": `<template><span /></template>\n<script setup lang="ts">\nconst props = defineProps<{ cents: number }>()\nimport { formatPrice } from '~~/server/utils/pricing'\n</script>`,
  });
  expect(diagnostics).toEqual([{ code: "NUXT0075", file: "app/components/PriceTag.vue", line: 4 }]);
});

test.each([
  `import type { Price } from '~~/server/utils/pricing'`,
  `import { type Price, type Currency } from '~~/server/utils/pricing'`,
  `export type { Price } from '~~/server/utils/pricing'`,
])("reports type-only server imports separately: %s", async (source) => {
  const diagnostics = await run({ "app/utils/price.ts": source });
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0076"]);
});

test("resolves ~/server against a Nuxt 3 root srcDir", async () => {
  const diagnostics = await run(
    {
      "components/PriceTag.vue": `<script setup lang="ts">\nimport { formatPrice } from '~/server/utils/pricing'\n</script>`,
    },
    { nuxt: "^3.17.0" },
  );
  expect(diagnostics).toMatchObject([{ code: "NUXT0075", file: "components/PriceTag.vue" }]);
});

test("reports server utils from an auto-registered layer", async () => {
  const diagnostics = await run({
    "layers/billing/server/utils/tax.ts": "export const tax = 0.2",
    "layers/billing/app/components/Tax.vue": `<script setup lang="ts">\nimport { tax } from '~~/server/utils/tax'\n</script>`,
    "app/pages/index.vue": `<script setup lang="ts">\nimport { tax } from '../../layers/billing/server/utils/tax'\n</script>`,
  });
  expect(diagnostics).toMatchObject([
    { code: "NUXT0075", file: "app/pages/index.vue" },
    { code: "NUXT0075", file: "layers/billing/app/components/Tax.vue" },
  ]);
});

test.each([
  ["server/api/price.get.ts", `import { formatPrice } from '../utils/pricing'`],
  ["server/routes/feed.ts", `import { formatPrice } from '~~/server/utils/pricing'`],
  ["layers/billing/server/api/tax.ts", `import { tax } from '../utils/tax'`],
  [
    "app/components/PriceTag.vue",
    `<script setup lang="ts">\nimport { formatPrice } from '~~/shared/utils/format-price'\n</script>`,
  ],
  [
    "app/components/PriceTag.vue",
    `<script setup lang="ts">\nimport { formatPrice } from '#shared/utils/format-price'\n</script>`,
  ],
  ["app/utils/price.ts", `import { useServer } from '~/composables/server/useServer'`],
  ["app/utils/price.ts", `import { createServer } from 'node:http'`],
  ["app/utils/price.ts", `import { formatPrice } from 'server/utils/pricing'`],
  ["app/components/PriceTag.spec.ts", `import { formatPrice } from '~~/server/utils/pricing'`],
  ["tests/pricing.test.ts", `import { formatPrice } from '~~/server/utils/pricing'`],
  ["nuxt.config.ts", `import { formatPrice } from './server/utils/pricing'`],
  ["modules/pricing.ts", `import { formatPrice } from '../server/utils/pricing'`],
])("ignores %s: %s", async (file, source) => {
  expect(await run({ [file]: source })).toEqual([]);
});

test.each([
  `import type { Handler } from '~~/server/api/price.get'`,
  `import { type Handler } from '~~/server/routes/feed'`,
  `export type { Handler } from '~~/server/plugins/db'`,
])("reports type-only imports from Nuxt-protected directories: %s", async (source) => {
  const diagnostics = await run({ "app/utils/price.ts": source });
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0076"]);
});

test.each([
  `import { handler } from '~~/server/api/price.get'`,
  `import { route } from '../../server/routes/feed'`,
  `import { auth } from '~~/server/middleware/auth'`,
  `import plugin from '~~/server/plugins/db'`,
  `import { db } from '#server/utils/db'`,
])("leaves imports Nuxt import protection already blocks to Nuxt: %s", async (source) => {
  expect(await run({ "app/utils/price.ts": source })).toEqual([]);
});

test("resolves custom serverDir and aliases from the Nuxt manifest", async () => {
  const manifest = {
    nuxtVersion: "4.0.0",
    vueVersion: "3.5.0",
    rootDir: "/fixture",
    srcDir: "app",
    appDir: "app",
    buildDir: ".nuxt",
    autoImports: [],
    components: [],
    modules: [],
    layers: [
      { root: ".", srcDir: "app", serverDir: "backend", priority: 0 },
      {
        root: "layers/billing",
        srcDir: "layers/billing/app",
        serverDir: "layers/billing/server",
        aliases: { "~": "../.." },
        priority: 1,
      },
    ],
    aliases: { "#db": "backend/database" },
    routeRules: {},
    serverHandlers: [],
  };
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ".nuxt/doctor.manifest.json": JSON.stringify(manifest),
      "app/utils/a.ts": `import { db } from '#db/client'`,
      "app/utils/b.ts": `import { price } from '~~/backend/utils/pricing'`,
      "app/utils/c.ts": `import { price } from '~~/server/utils/pricing'`,
      "app/utils/d.ts": `import { handler } from '~~/backend/api/price'`,
      "layers/billing/app/utils/e.ts": `import { price } from "~/server/utils/pricing"`,
      "layers/billing/server/utils/pricing.ts": "export const price = 1",
      "backend/utils/e.ts": `import { db } from '#db/client'`,
    },
    rules: [noServerUtilsInApp],
  });
  const files = result.diagnostics.map((diagnostic) => fixturePath(diagnostic.file));
  expect(files).toHaveLength(3);
  expect(files).toEqual(
    expect.arrayContaining(["app/utils/a.ts", "app/utils/b.ts", "layers/billing/app/utils/e.ts"]),
  );
});

test("puts runtime imports in recommended and type-only imports in strict", () => {
  expect(nuxtRulePack.presets.recommended).toContain(noServerUtilsInApp.meta.id);
  expect(nuxtRulePack.presets.recommended).not.toContain(noServerTypesInApp.meta.id);
  expect(nuxtRulePack.presets.strict).toEqual(
    expect.arrayContaining([noServerUtilsInApp.meta.id, noServerTypesInApp.meta.id]),
  );
});

test.each(["~", "@", "~~", "@@"])(
  "resolves relative %s layer overrides from the importer and preserves absolute overrides",
  async (alias) => {
    const manifest = {
      nuxtVersion: "4.0.0",
      rootDir: "/fixture",
      srcDir: "app",
      appDir: "app",
      buildDir: ".nuxt",
      autoImports: [],
      components: [],
      modules: [],
      routeRules: {},
      serverHandlers: [],
      aliases: { "~": "app", "@": "app", "~~": ".", "@@": "." },
      layers: [
        { root: ".", srcDir: "app", serverDir: "server", priority: 0 },
        {
          root: "layers/billing",
          srcDir: "layers/billing/app",
          serverDir: "layers/billing/server",
          aliases: { [alias]: "." },
          priority: 1,
        },
        {
          root: "layers/absolute",
          srcDir: "layers/absolute/app",
          aliases: { [alias]: "/external" },
          priority: 2,
        },
        { root: "/external", serverDir: "/external/server", priority: 3 },
      ],
    };
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ".nuxt/doctor.manifest.json": JSON.stringify(manifest),
        "layers/billing/app/utils/a.ts": `import { price } from '${alias}/server/utils/pricing'`,
        "layers/billing/app/utils/e.ts": `import { price } from '${alias}/../../server/utils/pricing'`,
        "layers/absolute/app/utils/b.ts": `import { price } from '${alias}/server/utils/pricing'`,
        "layers/billing/shared/utils/c.ts": `import { price } from '~/server/utils/pricing'`,
        "layers/billing/shared/utils/d.ts": `import { price } from '~~/server/utils/pricing'`,
      },
      rules: [noServerUtilsInApp],
    });
    expect(result.diagnostics.map((d) => [fixturePath(d.file), d.message])).toEqual([
      ["layers/absolute/app/utils/b.ts", expect.stringContaining("/external/server/utils/pricing")],
      [
        "layers/billing/app/utils/e.ts",
        expect.stringContaining("resolves to layers/billing/server/utils/pricing,"),
      ],
      [
        "layers/billing/shared/utils/d.ts",
        expect.stringContaining("resolves to server/utils/pricing,"),
      ],
    ]);
  },
);
