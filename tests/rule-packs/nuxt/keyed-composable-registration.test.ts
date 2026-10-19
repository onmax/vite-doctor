import { readFileSync } from "node:fs";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { createNuxtProjectInventory } from "../../../src/core/internal/nuxt-inventory.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { writeManifest } from "../../../src/rule-packs/nuxt/module.ts";
import { keyedComposableRegistrationRequired } from "../../../src/rule-packs/nuxt/rules/nuxt/keyed-composable-registration-required.ts";
import { withFixture } from "./nuxt-modern-rules-fixture.ts";

const ruleId = "nuxt/fetch/keyed-composable-registration-required";

function manifest(keyedComposables: unknown[], layers?: unknown[], withAutoImports = true) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    nuxtVersion: "4",
    vueVersion: "3.5",
    appDir: "app",
    ...(withAutoImports
      ? {
          autoImportEnabled: true,
          autoImports: [
            { name: "createUseFetch", from: "#app/composables/fetch", kind: "nuxt" },
            { name: "createUseAsyncData", from: "#app/composables/asyncData", kind: "nuxt" },
          ],
        }
      : {}),
    ...(layers ? { layers } : {}),
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

test("Nuxt manifest serializes keyed composables by name and resolved source", async () => {
  await withFixture(
    {
      "app/utils/api.ts": "export const useOrders = createUseFetch('/api/orders')",
      "app/utils/cart.ts": "export const useCart = createUseFetch('/api/cart')",
    },
    {},
    async (root) => {
      await writeManifest({
        options: {
          rootDir: root,
          buildDir: ".nuxt",
          modules: [],
          alias: { "~": join(root, "app") },
          optimization: {
            keyedComposables: [
              { name: "useState", source: "#app/composables/state", argumentLength: 2 },
              { name: "useOrders", source: join(root, "app/utils/api.ts"), argumentLength: 2 },
              { name: "useCart", source: "~/utils/cart", argumentLength: 2 },
            ],
          },
        },
        async callHook() {},
      });
      const written = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(written.keyedComposables).toEqual([
        { name: "useState" },
        { name: "useOrders", source: "app/utils/api.ts" },
        { name: "useCart", source: "app/utils/cart.ts" },
      ]);
    },
  );
});

test("Nuxt inventory ignores keyed composables that older manifests stringified", () => {
  const inventory = createNuxtProjectInventory("/project", {
    keyedComposables: [
      "[object Object]",
      "useOrders",
      { name: "useCart", source: "app/utils/cart.ts" },
      1,
      "useÜber",
    ],
  } as never);
  expect(inventory.keyedComposables).toEqual([
    { name: "useOrders" },
    { name: "useCart", source: "/project/app/utils/cart.ts" },
    { name: "useÜber" },
  ]);
});

test("accepts a factory registered by name in the Nuxt manifest", async () => {
  expect(
    await diagnose({
      "app/utils/api.ts": `export const useOrders = createUseFetch('/api/orders')`,
      ".nuxt/doctor.manifest.json": manifest(["useState", "useOrders"]),
    }),
  ).toEqual([]);
});

test("accepts a factory registered from its own file", async () => {
  expect(
    await diagnose({
      "app/utils/api.ts": `export const useOrders = createUseFetch('/api/orders')`,
      ".nuxt/doctor.manifest.json": manifest([{ name: "useOrders", source: "app/utils/api.ts" }]),
    }),
  ).toEqual([]);
});

test("reports a factory when the registration with its name points at another file", async () => {
  expect(
    await diagnose({
      "app/utils/api.ts": `export const useOrders = createUseFetch('/api/orders')`,
      ".nuxt/doctor.manifest.json": manifest([
        { name: "useOrders", source: "app/utils/legacy-api.ts" },
      ]),
    }),
  ).toEqual([ruleId]);
});

test("reports a factory when an old manifest only holds stringified objects", async () => {
  expect(
    await diagnose({
      "app/utils/api.ts": `export const useOrders = createUseFetch('/api/orders')`,
      ".nuxt/doctor.manifest.json": manifest(["[object Object]"]),
    }),
  ).toEqual([ruleId]);
});

test("reports an unresolved factory when auto-import evidence is unavailable", async () => {
  expect(
    await diagnose({
      "app/composables/useOrders.ts": "export const useOrders = createUseFetch('/api/orders')",
      ".nuxt/doctor.manifest.json": manifest(["[object Object]"], undefined, false),
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

test("reports an exported factory when global compiler scanning is disabled", async () => {
  expect(
    await diagnose({
      "app/composables/useOrders.ts": "export const useOrders = createUseFetch('/api/orders')",
      ".nuxt/doctor.manifest.json": manifest(
        [],
        [{ root: ".", srcDir: "app", compilerScan: false, priority: 0 }],
      ),
    }),
  ).toEqual([ruleId]);
});

test("reports an exported factory when its layer disables compiler scanning", async () => {
  expect(
    await diagnose({
      "layers/admin/composables/useOrders.ts":
        "export const useOrders = createUseFetch('/api/orders')",
      ".nuxt/doctor.manifest.json": manifest(
        [],
        [
          { root: ".", srcDir: "app", compilerScan: true, priority: 0 },
          { root: "layers/admin", srcDir: "layers/admin", compilerScan: false, priority: 1 },
        ],
      ),
    }),
  ).toEqual([ruleId]);
});

test.each([
  ["an export specifier", "const useOrders = createUseFetch('/api/orders')\nexport { useOrders }"],
  [
    "a renamed export specifier",
    "const useOrdersFactory = createUseFetch('/api/orders')\nexport { useOrdersFactory as useOrders }",
  ],
  ["a default export", "export default createUseFetch('/api/orders')"],
  ["an optional call", "export const useOrders = createUseFetch?.('/api/orders')"],
])("accepts a factory Nuxt scans through %s", async (_, source) => {
  expect(
    await diagnose({
      "app/composables/useOrders.ts": source,
      ".nuxt/doctor.manifest.json": manifest(["[object Object]"]),
    }),
  ).toEqual([]);
});

test("reports a type-only export specifier", async () => {
  expect(
    await diagnose({
      "app/composables/useOrders.ts":
        "const useOrders = createUseFetch('/api/orders')\nexport type { useOrders }",
    }),
  ).toEqual([ruleId]);
});

test("accepts an exported factory in a layer that keeps compiler scanning on", async () => {
  expect(
    await diagnose({
      "layers/admin/composables/useOrders.ts":
        "export const useOrders = createUseFetch('/api/orders')",
      ".nuxt/doctor.manifest.json": manifest(
        [],
        [
          { root: ".", srcDir: "app", compilerScan: true, priority: 0 },
          { root: "layers/admin", srcDir: "layers/admin", compilerScan: true, priority: 1 },
        ],
      ),
    }),
  ).toEqual([]);
});

test.each([
  [
    "a Vue file",
    "app/composables/useOrders.vue",
    "<script lang=\"ts\">\nexport const useOrders = createUseFetch('/api/orders')\n</script>",
  ],
  [
    "a constructor call",
    "app/composables/useOrders.ts",
    "export const useOrders = new createUseFetch('/api/orders')",
  ],
  [
    "a string-literal export name",
    "app/composables/useOrders.ts",
    "const useOrders = createUseFetch('/api/orders')\nexport { useOrders as \"orders\" }",
  ],
])("reports a factory Nuxt's scan skips: %s", async (_, file, source) => {
  expect(await diagnose({ [file]: source })).toEqual([ruleId]);
});

test.each([
  [
    "a locally shadowed factory",
    "app/composables/useOrders.ts",
    "function createUseFetch() { return () => {} }\nexport const useOrders = createUseFetch('/api/orders')",
  ],
  [
    "a factory imported from an unrelated module",
    "app/composables/useOrders.ts",
    "import { createUseFetch } from 'some-package'\nexport const useOrders = createUseFetch('/api/orders')",
  ],
])("reports a factory whose binding Nuxt cannot auto-import: %s", async (_, file, source) => {
  expect(await diagnose({ [file]: source })).toEqual([ruleId]);
});

test("accepts a default-exported factory registered as default", async () => {
  expect(
    await diagnose({
      "app/utils/api.ts": "export default createUseFetch('/api/orders')",
      ".nuxt/doctor.manifest.json": manifest(["default"]),
    }),
  ).toEqual([]);
});
