import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noV2Imports } from "../../../src/rule-packs/nitro/rules/no-v2-imports.ts";

test.each([
  ['export { createNitro } from "nitropack"', 'Import from "nitro".'],
  ['export * from "nitropack"', 'Import from "nitro".'],
  ['export * as legacy from "nitropack"', 'Import from "nitro".'],
  ['export type { NitroConfig } from "nitropack"', 'Import types from "nitro/types".'],
  ['export { type NitroConfig } from "nitropack"', 'Import types from "nitro/types".'],
  ['export type * from "nitropack"', 'Import types from "nitro/types".'],
  [
    'export { createNitro, type NitroConfig } from "nitropack"',
    'Import runtime values from "nitro" and types from "nitro/types".',
  ],
  [
    'export { defineNitroConfig } from "nitropack/config"',
    'Replace defineNitroConfig with defineConfig and import it from "nitro".',
  ],
  [
    'export { defineNitroConfig as config } from "nitropack/config"',
    'Replace defineNitroConfig with defineConfig and import it from "nitro".',
  ],
  ['export * from "nitropack/types"', 'Import types from "nitro/types".'],
  ['export { createNitro } from "nitropack/core"', 'Import builder APIs from "nitro/builder".'],
  [
    'export { useStorage } from "nitropack/runtime/storage"',
    "Use the documented Nitro 3 public subpath for this runtime API.",
  ],
  [
    'export * from "nitropack/kit"',
    "Remove this import and migrate to a supported Nitro 3 API; this subpath has no direct replacement.",
  ],
  [
    'export * from "nitro/deps/h3"',
    "Import the dependency directly; Nitro 3 removed nitro/deps subpaths.",
  ],
])("reports removed Nitro 2 reexport edges: %s", async (source, suggestion) => {
  const result = await runRuleFixture({
    rule: noV2Imports,
    framework: "nitro",
    dependencies: { nitro: "3.0.0-beta.1" },
    files: { "server/utils/compat.ts": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    code: "NITRO0014",
    ruleId: noV2Imports.meta.id,
    suggestion,
  });
});

test.each([
  'export { defineConfig } from "nitro"',
  'export type { NitroConfig } from "nitro/types"',
  'export { createNitro } from "nitro/builder"',
  'export * from "./nitropack"',
  'const value = "nitropack"; export { value }',
])("accepts supported and local reexports: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noV2Imports,
    framework: "nitro",
    dependencies: { nitro: "3.0.0-beta.1" },
    files: { "server/utils/compat.ts": source },
  });
  expect(result.diagnostics).toEqual([]);
});

test("keeps Nitro 2 reexports valid in a Nitro 2 runtime", async () => {
  const result = await runRuleFixture({
    rule: noV2Imports,
    framework: "nitro",
    dependencies: { nitropack: "2.13.4" },
    files: { "server/utils/compat.ts": 'export * from "nitropack"' },
  });
  expect(result.diagnostics).toEqual([]);
});
