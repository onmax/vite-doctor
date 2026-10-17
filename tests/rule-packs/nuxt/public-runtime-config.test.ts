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

async function publicConfigDiagnostics(publicConfig: string) {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: noSecretInPublicConfig,
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({ runtimeConfig: { public: { ${publicConfig} } } })`,
    },
  });
  return result.diagnostics;
}

test.each([
  `posthog: { key: "phc_project" }`,
  `productlane: { widgetKey: "widget" }`,
  `stripePublishableKey: "pk_live"`,
  `turnstile: { siteKey: "0x4AAA" }`,
  `recaptchaSiteKey: "site"`,
  `supabase: { anonKey: "anon" }`,
  `algoliaSearchApiKey: "search-only"`,
  `publicKey: "-----BEGIN PUBLIC KEY-----"`,
  `projectKey: "project"`,
  `cacheKey: "v1"`,
])("does not treat public-by-design keys as secrets: %s", async (publicConfig) => {
  expect(await publicConfigDiagnostics(publicConfig)).toHaveLength(0);
});

test.each([
  [`stripeSecretKey: "sk_live"`, "stripeSecretKey"],
  [`jwt: { privateKey: "-----BEGIN PRIVATE KEY-----" }`, "privateKey"],
  [`aws: { secretAccessKey: "secret" }`, "secretAccessKey"],
  [`supabase: { serviceRoleKey: "service" }`, "serviceRoleKey"],
  [`githubToken: "ghp_"`, "githubToken"],
  [`dbPassword: "hunter2"`, "dbPassword"],
])("reports secret-shaped key names as errors: %s", async (publicConfig, key) => {
  const diagnostics = await publicConfigDiagnostics(publicConfig);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.severity).toBe("error");
  expect(diagnostics[0]?.why).toContain(key);
});

test("reports generic API keys as a lower-confidence warning", async () => {
  const diagnostics = await publicConfigDiagnostics(`openaiApiKey: "sk-"`);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ severity: "warn", confidence: "heuristic-low" });
  expect(diagnostics[0]?.why).toContain("openaiApiKey");
  expect(diagnostics[0]?.why).toContain("browser");
});
