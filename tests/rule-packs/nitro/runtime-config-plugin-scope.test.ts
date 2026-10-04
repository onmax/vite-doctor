import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { requireEventRuntimeConfigInServer } from "../../../src/rule-packs/nitro/rules/require-event-runtime-config-in-server.ts";

test.each([
  "export default defineNitroPlugin(() => { console.log(useRuntimeConfig()) })",
  "export default defineNitroPlugin(async () => { await initialize(); configure(useRuntimeConfig()) })",
  "export default defineNitroPlugin(function configure(app) { initialize(useRuntimeConfig()) })",
  "import { defineNitroPlugin as plugin } from 'nitropack/runtime'; export default plugin(() => initialize(useRuntimeConfig()))",
  "export default () => initialize(useRuntimeConfig())",
  "export default function plugin(app) { initialize(useRuntimeConfig()) }",
])("does not invent a request event in a Nitro plugin initializer: %s", async (source) => {
  const result = await runRuleFixture({
    rule: requireEventRuntimeConfigInServer,
    framework: "nitro",
    files: { "server/plugins/config.ts": source },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["server/api/config.ts", "export default defineEventHandler(event => useRuntimeConfig())"],
  ["server/api/config.ts", "export default event => useRuntimeConfig()"],
  [
    "server/plugins/config.ts",
    "export default defineNitroPlugin(app => { app.hooks.hook('request', event => useRuntimeConfig()) })",
  ],
  [
    "server/plugins/config.ts",
    "export default defineNitroPlugin(app => { defineEventHandler(event => useRuntimeConfig()) })",
  ],
  ["server/utils/config.ts", "export function readConfig(event) { return useRuntimeConfig() }"],
  [
    "server/plugins/config.ts",
    "import { defineNitroPlugin } from './request-wrapper'; export default defineNitroPlugin(event => useRuntimeConfig())",
  ],
  [
    "server/plugins/config.ts",
    "function defineNitroPlugin(callback) { return defineEventHandler(callback) }; export default defineNitroPlugin(event => useRuntimeConfig())",
  ],
])("retains event-aware advice outside proven initialization: %s", async (file, source) => {
  const result = await runRuleFixture({
    rule: requireEventRuntimeConfigInServer,
    framework: "nitro",
    files: { [file]: source },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    requireEventRuntimeConfigInServer.meta.id,
  ]);
});

test("keeps startup and request-hook reads separate in the same plugin", async () => {
  const source =
    "export default defineNitroPlugin(app => { configure(useRuntimeConfig()); app.hooks.hook('request', event => configure(useRuntimeConfig())) })";
  const result = await runRuleFixture({
    rule: requireEventRuntimeConfigInServer,
    framework: "nitro",
    files: { "app/server/plugins/config.ts": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.range!.start).toBe(source.lastIndexOf("useRuntimeConfig()"));
});

test("retains the Nitro 2 runtime gate", async () => {
  const result = await runRuleFixture({
    rule: requireEventRuntimeConfigInServer,
    framework: "nitro",
    dependencies: { nitro: "3.0.0-beta.1" },
    files: {
      "server/api/config.ts": "export default defineEventHandler(() => useRuntimeConfig())",
    },
  });
  expect(result.diagnostics).toEqual([]);
});
