import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noSecretInPublicConfig } from "../../../src/rule-packs/nuxt/rules/nuxt/no-secret-in-public-config.ts";

test.each([
  `runtimeConfig: { public: { apiBase: "/api" }, secret: "private" }`,
  `publicAssets: [], runtimeConfig: { secret: "private" }`,
  `runtimeConfig: { public: { apiBase: "/api" } }, other: { secret: "private" }`,
  `runtimeConfig: { [public]: { apiSecret: "unknown" } }`,
  `runtimeConfig: { public: { [apiSecret]: "unknown" } }`,
  `runtimeConfig: { public: { value: build({ apiSecret: "private" }) } }`,
])("does not mistake private config for public config: %s", async (configuration) => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: noSecretInPublicConfig,
    files: { "nuxt.config.ts": `export default defineNuxtConfig({ ${configuration} })` },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  `runtimeConfig: { public: { apiSecret: "exposed" } }`,
  `runtimeConfig: { public: { padding: "${"x".repeat(160)}", apiSecret: "exposed" } }`,
  `runtimeConfig: { public: { service: { apiSecret: "exposed" } } }`,
  `runtimeConfig: { public: { ...{ apiSecret: "exposed" } } }`,
  `runtimeConfig: { public: { ...({ apiSecret: "exposed" } satisfies Record<string, unknown>) } }`,
  `'runtimeConfig': { 'public': { apiSecret: "exposed" } }`,
  `runtimeConfig: ({ public: { apiSecret: "exposed" } } satisfies Record<string, unknown>)`,
  `runtimeConfig: { [\`public\`]: { apiSecret: "exposed" } }`,
])("reports secrets structurally inside public runtime config: %s", async (configuration) => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: noSecretInPublicConfig,
    files: { "nuxt.config.ts": `export default defineNuxtConfig({ ${configuration} })` },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain("apiSecret");
});
