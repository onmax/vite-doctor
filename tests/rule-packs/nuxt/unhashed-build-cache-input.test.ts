import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noUnhashedBuildCacheInput } from "../../../src/rule-packs/nuxt/rules/nuxt/no-unhashed-build-cache-input.ts";

const CACHED_CONFIG = "export default defineNuxtConfig({ experimental: { buildCache: true } })";

async function run(
  files: Record<string, string>,
  { nuxt = "4.6.2", config = CACHED_CONFIG }: { nuxt?: string; config?: string | null } = {},
) {
  const result = await runProjectFixture({
    framework: "nuxt",
    dependencies: { nuxt },
    files: { ...(config === null ? {} : { "nuxt.config.ts": config }), ...files },
    rules: [noUnhashedBuildCacheInput],
  });
  return result.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    file: fixturePath(diagnostic.file),
    related: diagnostic.related?.map((item) => ({ ...item, file: fixturePath(item.file) })),
  }));
}

function fixturePath(file: string | undefined) {
  return file?.replace(/^.*\/vite-doctor-fixture-[^/]+\//, "");
}

function manifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    generatedAt: "2999-01-01T00:00:00.000Z",
    nuxtVersion: "4.6.2",
    vueVersion: "3.5.0",
    rootDir: "/fixture",
    srcDir: "app",
    appDir: "app",
    buildDir: ".nuxt",
    autoImports: [],
    components: [],
    modules: [],
    layers: [{ root: ".", srcDir: "app", serverDir: "server", priority: 0 }],
    aliases: {},
    routeRules: {},
    serverHandlers: [],
    ...overrides,
  });
}

test("reports a root lib/ the app imports through ~~", async () => {
  const diagnostics = await run({
    "app/utils/alerts.ts": `export { formatAlert } from '~~/lib/format-alert'`,
    "lib/format-alert.ts": "export const formatAlert = (value: string) => value.trim()",
  });

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    code: "NUXT0093",
    file: "app/utils/alerts.ts",
    severity: "warn",
    range: { line: 1 },
  });
  expect(diagnostics[0]?.why).toContain("lib/ feeds the Vue build");
  expect(diagnostics[0]?.why).toContain("app/utils/alerts.ts:1 imports ~~/lib/format-alert");
  expect(diagnostics[0]?.suggestion).toContain("Move the code the app uses under app/");
  expect(diagnostics[0]?.suggestion).toContain("hashFiles('lib/**')");
});

test("reports one diagnostic per directory with the other importing sites as related", async () => {
  const diagnostics = await run({
    "app/components/Price.vue": `<script setup lang="ts">\nimport { money } from '../../lib/money'\n</script>\n<template><span>{{ money(1) }}</span></template>`,
    "app/pages/index.vue": `<script setup>\nconst { date } = await import('~~/lib/date')\n</script>`,
    "app/utils/format.ts": `import { money } from '@@/lib/money'\nexport const label = money(2)`,
    "lib/money.ts": `import { round } from '../utils/round'\nexport const money = (cents: number) => round(cents / 100)`,
    "lib/date.ts": "export const date = () => 'today'",
    "utils/round.ts": "export const round = Math.round",
  });

  const lib = diagnostics.find((diagnostic) => diagnostic.why.includes("lib/ feeds the Vue build"));
  expect(diagnostics).toHaveLength(2);
  expect(lib).toMatchObject({ file: "app/components/Price.vue", range: { line: 2 } });
  expect(lib?.related?.map((item) => item.file)).toEqual([
    "app/pages/index.vue",
    "app/utils/format.ts",
  ]);
  // utils/round.ts is reached only through lib/money.ts, which is just as stale.
  const utils = diagnostics.find((diagnostic) =>
    diagnostic.why.includes("utils/ feeds the Vue build"),
  );
  expect(utils).toMatchObject({ file: "lib/money.ts" });
});

test.each([
  ["4.6.2", 1],
  ["4.5.0", 1],
  ["3.17.0", 1],
  ["4.6.3", 0],
  ["5.0.0", 0],
])("gates shared/ on the Nuxt version that hashes it: %s", async (nuxt, expected) => {
  const diagnostics = await run(
    {
      "app/pages/index.vue": `<script setup lang="ts">\nimport { slugify } from '#shared/utils/slugify'\n</script>`,
      "shared/utils/slugify.ts": "export const slugify = (value: string) => value.toLowerCase()",
    },
    { nuxt },
  );

  expect(diagnostics).toHaveLength(expected);
  if (expected) {
    expect(diagnostics[0]?.why).toContain(`Nuxt ${nuxt} hashes only app/`);
    expect(diagnostics[0]?.suggestion).toContain("nuxt/nuxt#36704");
  }
});

test("reports shared/ auto-imports used in a template or script, not shadowed names", async () => {
  const diagnostics = await run({
    ".nuxt/doctor.manifest.json": manifest({
      autoImports: [
        { name: "sharedMarker", from: "~~/shared/utils/marker" },
        { name: "SharedShape", from: "~~/shared/types/shape", type: true },
      ],
    }),
    "app/app.vue": "<template><div>{{ sharedMarker }}</div></template>",
    "app/composables/useMarker.ts": "export const useMarker = () => sharedMarker",
    "app/composables/useLocal.ts":
      "const sharedMarker = 'local'\nexport const useLocal = () => sharedMarker",
    "app/components/List.vue":
      '<template><p v-for="sharedMarker in items">{{ sharedMarker }}</p></template>',
    "app/composables/useShape.ts": "export const useShape = (shape: SharedShape) => shape",
    "shared/utils/marker.ts": "export const sharedMarker = 'v1'",
    "shared/types/shape.ts": "export interface SharedShape { id: string }",
  });

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    file: "app/app.vue",
    confidence: "manifest-backed",
    range: { line: 1 },
  });
  expect(diagnostics[0]?.why).toContain(
    "app/app.vue:1 uses the auto-imported sharedMarker from shared/utils/marker.ts",
  );
  expect(diagnostics[0]?.related?.map((item) => item.file)).toEqual([
    "app/composables/useMarker.ts",
  ]);
});

test("skips type-only use of shared/", async () => {
  const diagnostics = await run({
    "app/utils/a.ts": `import type { Shape } from '~~/shared/types/shape'`,
    "app/utils/b.ts": `import { type Shape } from '~~/shared/types/shape'`,
    "app/utils/c.ts": `import { Shape } from '~~/shared/types/shape'\nexport const f = (s: Shape) => s`,
    "app/utils/d.ts": `export type { Shape } from '~~/shared/types/shape'`,
    "app/utils/e.ts": `import { Env } from '~~/shared/types/env'`,
    "shared/types/shape.ts": "export interface Shape { id: string }\nexport type Id = string",
    "shared/types/env.d.ts": "export interface Env { mode: string }",
  });

  expect(diagnostics).toHaveLength(0);
});

test("reports a value imported next to types from the same shared/ file", async () => {
  const diagnostics = await run({
    "app/utils/a.ts": `import { type Shape, isShape } from '~~/shared/types/shape'`,
    "shared/types/shape.ts":
      "export interface Shape { id: string }\nexport const isShape = (value: unknown): value is Shape => !!value",
  });

  expect(diagnostics).toHaveLength(1);
});

test("skips paths another local layer's srcDir covers", async () => {
  const diagnostics = await run({
    ".nuxt/doctor.manifest.json": manifest({
      layers: [
        { root: ".", srcDir: "app", serverDir: "server", priority: 0 },
        {
          root: "layers/base",
          srcDir: "layers/base/app",
          serverDir: "layers/base/server",
          priority: 1,
        },
      ],
    }),
    "app/utils/a.ts": `import { base } from '~~/layers/base/app/utils/base'`,
    "app/utils/b.ts": `import { helper } from '~~/layers/base/lib/helper'`,
    "layers/base/app/utils/base.ts": "export const base = 1",
    "layers/base/lib/helper.ts": "export const helper = 1",
  });

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ file: "app/utils/b.ts" });
  expect(diagnostics[0]?.why).toContain("layers/base/lib/ feeds the Vue build");
  expect(diagnostics[0]?.confidence).toBe("proven");
});

test.each([
  ["no buildCache", "export default defineNuxtConfig({})"],
  ["buildCache off", "export default defineNuxtConfig({ experimental: { buildCache: false } })"],
  [
    "a computed buildCache",
    "export default defineNuxtConfig({ experimental: { buildCache: !!process.env.CACHE } })",
  ],
  [
    "buildCache off in production",
    "export default defineNuxtConfig({ experimental: { buildCache: true }, $production: { experimental: { buildCache: false } } })",
  ],
])("does not report with %s", async (_name, config) => {
  const diagnostics = await run(
    {
      "app/utils/a.ts": `import { helper } from '~~/lib/helper'`,
      "lib/helper.ts": "export const helper = 1",
    },
    { config },
  );

  expect(diagnostics).toHaveLength(0);
});

test("does not report when the manifest resolves buildCache to false", async () => {
  const diagnostics = await run({
    ".nuxt/doctor.manifest.json": manifest({ productionBuildCache: false }),
    "app/utils/a.ts": `import { helper } from '~~/lib/helper'`,
    "lib/helper.ts": "export const helper = 1",
  });

  expect(diagnostics).toHaveLength(0);
});

test("does not report the Nuxt 3 layout, where srcDir is the root", async () => {
  const diagnostics = await run({
    ".nuxt/doctor.manifest.json": manifest({
      srcDir: ".",
      appDir: ".",
      layers: [{ root: ".", srcDir: ".", serverDir: "server", priority: 0 }],
    }),
    "components/Price.vue": `<script setup>\nimport { money } from '~/lib/money'\n</script>`,
    "pages/index.vue": `<script setup>\nimport { slugify } from '~~/shared/utils/slugify'\n</script>`,
    "lib/money.ts": "export const money = 1",
    "shared/utils/slugify.ts": "export const slugify = (value) => value",
  });

  expect(diagnostics).toHaveLength(0);
});

test("skips server/, public/, node_modules, hashed root files and generated code", async () => {
  const diagnostics = await run({
    "app/utils/a.ts": [
      `import { price } from '~~/server/utils/price'`,
      `import logo from '~~/public/logo.svg'`,
      `import { version } from '~~/package.json'`,
      `import { lib } from '~~/node_modules/some-lib/index.js'`,
      `import { routes } from '~~/.nuxt/routes'`,
      `import config from '~~/nuxt.config'`,
    ].join("\n"),
    "server/utils/price.ts": "export const price = 1",
    "public/logo.svg": "<svg />",
    "node_modules/some-lib/index.js": "export const lib = 1",
    ".nuxt/routes.ts": "export const routes = []",
  });

  expect(diagnostics).toHaveLength(0);
});

test("ignores tests and stories inside srcDir", async () => {
  const diagnostics = await run({
    "app/utils/money.test.ts": `import { helper } from '~~/lib/helper'`,
    "app/components/Price.stories.ts": `import { helper } from '~~/lib/helper'`,
    "app/utils/__tests__/money.ts": `import { helper } from '~~/lib/helper'`,
    "lib/helper.ts": "export const helper = 1",
  });

  expect(diagnostics).toHaveLength(0);
});

test("reports a local module's runtime plugin registered from outside srcDir", async () => {
  const diagnostics = await run({
    ".nuxt/doctor.manifest.json": manifest({
      pluginFiles: ["modules/analytics/runtime/plugin.ts", "node_modules/nuxt/dist/plugin.js"],
    }),
    "modules/analytics/index.ts": "export default defineNuxtModule({})",
    "modules/analytics/runtime/plugin.ts": "export default defineNuxtPlugin(() => {})",
  });

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    file: "modules/analytics/runtime/plugin.ts",
    confidence: "manifest-backed",
  });
  expect(diagnostics[0]?.why).toContain("modules/ feeds the Vue build");
});

test("stays silent when nuxt.config computes srcDir and there is no manifest", async () => {
  const diagnostics = await run(
    {
      "app/utils/a.ts": `import { helper } from '~~/lib/helper'`,
      "lib/helper.ts": "export const helper = 1",
    },
    {
      config:
        "export default defineNuxtConfig({ srcDir: process.env.SRC, experimental: { buildCache: true } })",
    },
  );

  expect(diagnostics).toHaveLength(0);
});

test("follows the auto-import source Nuxt picks by priority", async () => {
  const diagnostics = await run({
    ".nuxt/doctor.manifest.json": manifest({
      autoImports: [
        { name: "formatPrice", from: "~~/shared/utils/price", priority: 1 },
        { name: "formatPrice", from: "~/utils/price", priority: 2 },
      ],
    }),
    "app/app.vue": "<template><div>{{ formatPrice(1) }}</div></template>",
    "app/utils/price.ts": "export const formatPrice = String",
    "shared/utils/price.ts": "export const formatPrice = String",
  });

  expect(diagnostics).toHaveLength(0);
});

test.each(["scratch/unused.ts", "plugins/nested/unused.ts", "composables/nested/unused.ts"])(
  "does not seed unregistered app/%s, but follows it when imported",
  async (path) => {
    const files = {
      [`app/${path}`]: `import { helper } from '~~/lib/helper'; export const value = helper`,
      "lib/helper.ts": "export const helper = 1",
    };
    expect(await run(files)).toHaveLength(0);
    expect(
      await run({
        ...files,
        "app/app.vue": `<script setup>import { value } from './${path}'</script>`,
      }),
    ).toHaveLength(1);
  },
);

test("ignores stale manifest layout, aliases, plugins and auto-imports", async () => {
  expect(
    await run({
      ".nuxt/doctor.manifest.json": manifest({
        generatedAt: "2000-01-01T00:00:00.000Z",
        pluginFiles: ["modules/old/plugin.ts"],
        aliases: { "#old": "/fixture/lib" },
        autoImports: [{ name: "oldValue", from: "~~/lib/value" }],
      }),
      "app/app.vue": `<script setup>import { value } from '#old/value'; console.log(oldValue)</script>`,
      "lib/value.ts": "export const value = 1; export const oldValue = 1",
      "modules/old/plugin.ts": "export default defineNuxtPlugin(() => {})",
    }),
  ).toHaveLength(0);
});

test.each(["export { Shape } from './shape'", "export * from './shape'"])(
  "filters type-only barrel chains: %s",
  async (barrel) => {
    const files = {
      "app/app.vue": `<script setup lang="ts">import { Shape } from '~~/lib'; const shape: Shape = { id: 'a' }</script>`,
      "lib/index.ts": "export * from './barrel'",
      "lib/barrel.ts": barrel,
      "lib/shape.ts": "export interface Shape { id: string }",
    };
    expect(await run(files)).toHaveLength(0);
    expect(
      await run({ ...files, "lib/shape.ts": "export const Shape = { id: 'a' }" }),
    ).toHaveLength(1);
  },
);

test("keeps unresolved and cyclic barrel chains conservative", async () => {
  expect(
    await run({
      "app/app.vue": `<script setup>import { value } from '~~/lib'</script>`,
      "lib/index.ts": "export * from './other'",
      "lib/other.ts": "export * from './index'",
    }),
  ).toHaveLength(1);
});

test("follows explicitly registered nested plugins inside srcDir", async () => {
  expect(
    await run({
      ".nuxt/doctor.manifest.json": manifest({ pluginFiles: ["app/plugins/nested/custom.ts"] }),
      "app/plugins/nested/custom.ts": `import { helper } from '~~/lib/helper'; export default defineNuxtPlugin(() => helper)`,
      "lib/helper.ts": "export const helper = 1",
    }),
  ).toHaveLength(1);
});

test.each([
  "<template>{{ registeredValue }}</template>",
  "<script setup>console.log(registeredValue)</script>",
])("follows used auto-imports through hashed non-convention sources: %s", async (app) => {
  const files = {
    ".nuxt/doctor.manifest.json": manifest({
      autoImports: [{ name: "registeredValue", from: "~/scratch/registered" }],
    }),
    "app/scratch/registered.ts":
      "import { helper } from '~~/lib/helper'; export const registeredValue = helper",
    "lib/helper.ts": "export const helper = 1",
  };
  expect(await run(files)).toHaveLength(0);
  const diagnostics = await run({ ...files, "app/app.vue": app });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ file: "app/scratch/registered.ts" });
  expect(diagnostics[0]?.why).toContain("lib/ feeds the Vue build");
  expect(
    await run({
      ...files,
      "app/app.vue":
        "<script setup>const registeredValue = 1; console.log(registeredValue)</script>",
    }),
  ).toHaveLength(0);
});
