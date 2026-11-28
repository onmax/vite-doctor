import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import { noServerUtilsInApp } from "../../../src/rule-packs/nuxt/rules/nuxt/no-server-utils-in-app.ts";
import { noVueOrNitroContextInShared } from "../../../src/rule-packs/nuxt/rules/nuxt/no-vue-or-nitro-context-in-shared.ts";

async function run(files: Record<string, string>) {
  const result = await runProjectFixture({
    framework: "nuxt",
    files: { "app/utils/format.ts": "export const format = (n: number) => String(n)", ...files },
    rules: [noVueOrNitroContextInShared],
  });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
  }));
}

test.each([
  `import { ref } from 'vue'`,
  `export { ref } from 'vue'`,
  `export * from 'vue'`,
  `const { ref } = await import('vue')`,
  `import { useNuxtApp } from '#app'`,
  `import { useNuxtApp } from '#app/nuxt'`,
  `import { useRoute } from '#imports'`,
  `import { useToast } from '#ui/composables/useToast'`,
  `import { getQuery } from 'h3'`,
  `import { useStorage } from 'nitropack/runtime'`,
  `import { useStorage } from 'nitro/storage'`,
  `import { readFile } from 'node:fs/promises'`,
  `import { readFileSync } from 'fs'`,
  `import { createHash } from 'node:crypto'`,
  `import { format } from '~/utils/format'`,
  `import { format } from '@/utils/format'`,
  `import { format } from '../../app/utils/format'`,
  `export const prefix = process.env.SLUG_PREFIX`,
  `export const prefix = process.env['SLUG_PREFIX']`,
  `export const prefix = process['env'].SLUG_PREFIX`,
  `export const mode = process.env['NODE_ENV']`,
  `export const mode = process['env'].NODE_ENV`,
  `export const mode = process['env']['NODE_ENV']`,
  `process.env.COUNT += '1'`,
  `export function currentPath() { return useRoute().path }`,
])("reports shared code that needs one runtime: %s", async (source) => {
  expect(await run({ "shared/utils/slug.ts": source })).toEqual([
    { code: "NUXT0059", file: "shared/utils/slug.ts" },
  ]);
});

test("reports layer shared directories", async () => {
  expect(
    await run({ "layers/billing/shared/utils/tax.ts": `import { computed } from 'vue'` }),
  ).toEqual([{ code: "NUXT0059", file: "layers/billing/shared/utils/tax.ts" }]);
});

test("uses the configured shared directory instead of the default in each layer", async () => {
  const manifest = {
    nuxtVersion: "4.6.4",
    appDir: "app",
    layers: [
      { root: ".", srcDir: "app", sharedDir: "common", priority: 0 },
      { root: "layers/billing", sharedDir: "layers/billing/common", priority: 1 },
    ],
  };
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ".nuxt/doctor.manifest.json": JSON.stringify(manifest),
      "common/utils/prefix.ts": `import 'vue'\nimport '#server/utils/price'`,
      "shared/utils/prefix.ts": `import 'vue'\nimport '#server/utils/price'`,
      "layers/billing/common/utils/prefix.ts": `import 'vue'`,
      "layers/billing/shared/utils/prefix.ts": `import 'vue'`,
    },
    rules: [noVueOrNitroContextInShared, noServerUtilsInApp],
  });
  expect(
    result.diagnostics
      .map(({ code, file }) => `${code}:${file?.replace(`${result.project.root}/`, "")}`)
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual([
    "NUXT0059:common/utils/prefix.ts",
    "NUXT0059:layers/billing/common/utils/prefix.ts",
    "NUXT0075:common/utils/prefix.ts",
  ]);
});

test("uses literal dir.shared without a manifest", async () => {
  expect(
    await run({
      "nuxt.config.ts": `export default defineNuxtConfig({ dir: { shared: 'common' } })`,
      "common/utils/prefix.ts": `import 'vue'`,
      "shared/utils/prefix.ts": `import 'vue'`,
    }),
  ).toEqual([{ code: "NUXT0059", file: "common/utils/prefix.ts" }]);
});

test("invalidates cached boundary results after changing only dir.shared", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-shared-boundary-"));
  const config = join(root, "nuxt.config.ts");
  const options = { root, rules: noVueOrNitroContextInShared.meta.id };
  const diagnostics = async (cache: boolean) =>
    (await runViteDoctor({ ...options, cache })).diagnostics
      .filter((item) => item.code === "NUXT0059")
      .map((item) => item.file);
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { nuxt: "4.6.4" } }));
    for (const dir of ["common", "shared"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "value.ts"), `import { ref } from 'vue'`);
    }
    writeFileSync(config, `export default defineNuxtConfig({ dir: { shared: 'common' } })`);
    expect(await diagnostics(true)).toEqual([join(root, "common/value.ts")]);

    writeFileSync(config, `export default defineNuxtConfig({ dir: { shared: 'shared' } })`);
    const uncached = await diagnostics(false);
    expect(uncached).toEqual([join(root, "shared/value.ts")]);
    expect(await diagnostics(true)).toEqual(uncached);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  `import type { Ref } from 'vue'`,
  `import { type Ref } from 'vue'`,
  `export type { H3Event } from 'h3'`,
  `import type { ButtonProps } from '#ui/types'`,
  `import { z } from 'zod'`,
  `import { EventEmitter } from 'events'`,
  `import { createHash } from 'crypto'`,
  `import { slugify } from './slugify'`,
  `import { slugify } from '#shared/utils/slugify'`,
  `export const dev = process.env.NODE_ENV !== 'production'`,
  `export function prefix(process: { env: { PREFIX: string } }) { return process.env.PREFIX }`,
  `process.env.VALUE = 'test'`,
  `delete process.env.VALUE`,
  `export const slug = (text: string) => text.toLowerCase()`,
])("allows runtime-neutral shared code: %s", async (source) => {
  expect(await run({ "shared/utils/slug.ts": source })).toEqual([]);
});

test("ignores the same code outside shared/ and in shared tests", async () => {
  const source = `import { ref } from 'vue'\nimport { readFile } from 'node:fs/promises'`;
  expect(
    await run({
      "app/composables/useSlug.ts": source,
      "server/utils/slug.ts": source,
      "shared/utils/slug.test.ts": source,
    }),
  ).toEqual([]);
});
