import { readFileSync } from "node:fs";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { createNuxtProjectInventory } from "../../../src/core/internal/nuxt-inventory.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { writeManifest } from "../../../src/rule-packs/nuxt/module.ts";
import { keyedComposableRegistrationRequired } from "../../../src/rule-packs/nuxt/rules/nuxt/keyed-composable-registration-required.ts";
import { withFixture } from "./nuxt-modern-rules-fixture.ts";

const ruleId = "nuxt/fetch/keyed-composable-registration-required";

function manifest(keyedComposables: unknown[]) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    nuxtVersion: "4",
    vueVersion: "3.5",
    appDir: "app",
    keyedComposables,
  });
}

async function diagnose(files: Record<string, string>) {
  const result = await runRuleFixture({
    rule: keyedComposableRegistrationRequired,
    framework: "nuxt",
    files,
  });
  return result.diagnostics.map((diagnostic) => diagnostic.ruleId);
}

test("Nuxt manifest serializes keyed composables by name", async () => {
  await withFixture({}, {}, async (root) => {
    await writeManifest({
      options: {
        rootDir: root,
        buildDir: ".nuxt",
        modules: [],
        optimization: {
          keyedComposables: [
            { name: "useState", source: "#app/composables/state", argumentLength: 2 },
            { name: "useOrders", source: join(root, "app/utils/api.ts"), argumentLength: 2 },
          ],
        },
      },
      async callHook() {},
    });
    const written = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(written.keyedComposables).toEqual(["useState", "useOrders"]);
  });
});

test("Nuxt inventory ignores keyed composables that older manifests stringified", () => {
  const inventory = createNuxtProjectInventory("/project", {
    keyedComposables: ["[object Object]", "useOrders", { name: "useCart" }, 1],
  } as never);
  expect(inventory.keyedComposables).toEqual(["useOrders", "useCart"]);
});

test("accepts a factory registered by name in the Nuxt manifest", async () => {
  expect(
    await diagnose({
      "app/utils/api.ts": `export const useOrders = createUseFetch('/api/orders')`,
      ".nuxt/doctor.manifest.json": manifest(["useState", "useOrders"]),
    }),
  ).toEqual([]);
});

test("reports a factory when an old manifest only holds stringified objects", async () => {
  expect(
    await diagnose({
      "app/utils/api.ts": `export const useOrders = createUseFetch('/api/orders')`,
      ".nuxt/doctor.manifest.json": manifest(["[object Object]"]),
    }),
  ).toEqual([ruleId]);
});

test.each(["app/composables/usePlcMapping.ts", "app/composables/nested/usePlcMapping.ts"])(
  "accepts an exported factory Nuxt scans in %s",
  async (file) => {
    expect(
      await diagnose({
        [file]: `const PLC_MAPPING_ASYNC_KEY = 'plc-mapping'
export const usePlcMappingData = createUseAsyncData<PlcMapping>({
  default: () => ({}),
})`,
        ".nuxt/doctor.manifest.json": manifest(["[object Object]"]),
      }),
    ).toEqual([]);
  },
);

test.each([
  [
    "unexported factory in composables",
    "app/composables/useOrders.ts",
    "const useOrders = createUseFetch('/api/orders')",
  ],
  [
    "exported factory outside composables",
    "app/utils/api.ts",
    "export const useOrders = createUseFetch('/api/orders')",
  ],
  [
    "factory inside a function",
    "app/composables/useOrders.ts",
    "export function useOrders() { const load = createUseFetch('/api/orders'); return load() }",
  ],
])("reports an unregistered factory: %s", async (_, file, source) => {
  expect(await diagnose({ [file]: source })).toEqual([ruleId]);
});
