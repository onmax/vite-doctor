import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
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
