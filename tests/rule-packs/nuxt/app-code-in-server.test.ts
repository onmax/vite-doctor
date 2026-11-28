import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  noAppCodeInServer,
  noAppTypesInServer,
} from "../../../src/rule-packs/nuxt/rules/nuxt/no-app-code-in-server.ts";
import nuxtRulePack from "../../../src/rule-packs/nuxt/rules/nuxt.ts";

const appCode = {
  "app/utils/format.ts": "export const formatPrice = (cents: number) => String(cents)",
  "app/components/PriceTag.vue": "<template><span /></template>",
};

async function run(files: Record<string, string>, dependencies?: Record<string, string>) {
  const result = await runProjectFixture({
    framework: "nuxt",
    dependencies,
    files: { ...appCode, ...files },
    rules: [noAppCodeInServer, noAppTypesInServer],
  });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: fixturePath(diagnostic.file),
  }));
}

function fixturePath(file: string | undefined) {
  return file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, "");
}

test.each([
  ["server/api/cart.get.ts", `import { formatPrice } from '~/utils/format'`],
  ["server/api/cart.get.ts", `import { formatPrice } from '@/utils/format'`],
  ["server/api/cart.get.ts", `import { formatPrice } from '~~/app/utils/format'`],
  ["server/api/cart.get.ts", `import { formatPrice } from '@@/app/utils/format'`],
  ["server/utils/cart.ts", `import { formatPrice } from '../../app/utils/format'`],
  ["server/utils/cart.ts", `export { formatPrice } from '~/utils/format'`],
  ["server/utils/cart.ts", `export * from '~/utils/format'`],
  ["server/routes/og.ts", `const { formatPrice } = await import('~/utils/format')`],
  ["server/utils/email.ts", `import PriceTag from '~/components/PriceTag.vue'`],
  ["server/plugins/init.ts", `import '~/utils/format'`],
  ["server/utils/cart.ts", `import { formatPrice, type Cents } from '~/utils/format'`],
])("reports app code imported into %s: %s", async (file, source) => {
  expect(await run({ [file]: source })).toEqual([{ code: "NUXT0108", file }]);
});

test.each([
  `import type { Cents } from '~/utils/format'`,
  `import { type Cents } from '~/utils/format'`,
  `export type { Cents } from '~/utils/format'`,
])("reports type-only app imports separately: %s", async (source) => {
  const diagnostics = await run({ "server/api/cart.get.ts": source });
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0109"]);
});

test("resolves ~/ against a Nuxt 3 root srcDir", async () => {
  const diagnostics = await run(
    {
      "utils/format.ts": "export const formatPrice = (cents: number) => String(cents)",
      "server/api/cart.get.ts": `import { formatPrice } from '~/utils/format'`,
      "server/api/tax.get.ts": `import { tax } from '~/server/utils/tax'`,
      "server/utils/tax.ts": "export const tax = 0.2",
    },
    { nuxt: "^3.17.0" },
  );
  expect(diagnostics).toEqual([{ code: "NUXT0108", file: "server/api/cart.get.ts" }]);
});

test("reports app code imported into a layer's server directory", async () => {
  const diagnostics = await run({
    "layers/billing/app/utils/tax.ts": "export const tax = 0.2",
    "layers/billing/server/api/tax.get.ts": `import { tax } from '../../app/utils/tax'`,
  });
  expect(diagnostics).toEqual([{ code: "NUXT0108", file: "layers/billing/server/api/tax.get.ts" }]);
});

test.each([
  ["server/api/cart.get.ts", `import { formatPrice } from '~~/shared/utils/format'`],
  ["server/api/cart.get.ts", `import { formatPrice } from '#shared/utils/format'`],
  ["server/api/cart.get.ts", `import { tax } from '../utils/tax'`],
  ["server/api/cart.get.ts", `import { tax } from '#server/utils/tax'`],
  ["server/api/cart.get.ts", `import { useNuxtApp } from '#app'`],
  ["server/api/cart.get.ts", `import { routes } from '#build/routes'`],
  ["server/api/cart.get.ts", `import { ref } from 'vue'`],
  ["server/api/cart.get.ts", `import countries from '~/assets/countries.json'`],
  ["server/api/cart.get.spec.ts", `import { formatPrice } from '~/utils/format'`],
  [
    "app/pages/index.vue",
    `<script setup lang="ts">\nimport { formatPrice } from '~/utils/format'\n</script>`,
  ],
  ["shared/utils/price.ts", `import { formatPrice } from '~/utils/format'`],
  ["nuxt.config.ts", `import { formatPrice } from './app/utils/format'`],
])("ignores %s: %s", async (file, source) => {
  expect(await run({ "server/utils/tax.ts": "export const tax = 0.2", [file]: source })).toEqual(
    [],
  );
});

test("puts runtime imports in recommended and type-only imports in strict", () => {
  expect(nuxtRulePack.presets.recommended).toContain(noAppCodeInServer.meta.id);
  expect(nuxtRulePack.presets.recommended).not.toContain(noAppTypesInServer.meta.id);
  expect(nuxtRulePack.presets.strict).toEqual(
    expect.arrayContaining([noAppCodeInServer.meta.id, noAppTypesInServer.meta.id]),
  );
});
