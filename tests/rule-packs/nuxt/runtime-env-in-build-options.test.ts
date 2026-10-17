import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noRuntimeEnvInBuildOptions } from "../../../src/rule-packs/nuxt/rules/nuxt/no-runtime-env-in-build-options.ts";

async function run(config: string, file = "nuxt.config.ts") {
  return runRuleFixture({
    framework: "nuxt",
    rule: noRuntimeEnvInBuildOptions,
    files: { [file]: config },
  });
}

test("reports a tenant variable frozen into a module option through a top-level binding", async () => {
  const result = await run(`
const defaultOrganizationCode = process.env.NUXT_PUBLIC_ORGANIZATION_CODE
  || process.env.NUXT_PUBLIC_DEMO_ORGANIZATION
  || ''

export default defineNuxtConfig({
  runtimeConfig: { public: { organizationCode: defaultOrganizationCode } },
  piniaPluginPersistedstate: { key: \`\${defaultOrganizationCode}:%id\` },
})
`);

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("NUXT0090");
  expect(result.diagnostics[0]?.why).toContain("piniaPluginPersistedstate.key");
  expect(result.diagnostics[0]?.why).toContain("runtimeConfig.public.organizationCode");
});

test.each([
  [
    "a direct read",
    `runtimeConfig: { public: { directusUrl: '' } },
  apollo: { clients: { default: { httpEndpoint: process.env.NUXT_PUBLIC_DIRECTUS_URL + '/graphql' } } },`,
  ],
  [
    "a computed member read",
    `runtimeConfig: { public: { directusUrl: '' } },
  apollo: { clients: { default: { httpEndpoint: process.env['NUXT_PUBLIC_DIRECTUS_URL'] } } },`,
  ],
  [
    "a NITRO_ variable for a private key",
    `runtimeConfig: { apiSecret: '' },
  myModule: { secret: process.env.NITRO_API_SECRET },`,
  ],
  [
    "an option inside an array",
    `runtimeConfig: { public: { siteUrl: '' } },
  modules: [['some-module', { url: process.env.NUXT_PUBLIC_SITE_URL }]],`,
  ],
])("reports %s", async (_name, properties) => {
  const result = await run(`export default defineNuxtConfig({
  ${properties}
})`);

  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  [
    "reads inside runtimeConfig",
    `runtimeConfig: { public: { directusUrl: process.env.NUXT_PUBLIC_DIRECTUS_URL } },
  $production: { runtimeConfig: { public: { directusUrl: process.env.NUXT_PUBLIC_DIRECTUS_URL } } },
  nitro: { runtimeConfig: { directusUrl: process.env.NUXT_DIRECTUS_URL } },`,
  ],
  [
    "a fallback to a build-time variable",
    `runtimeConfig: { public: { appVersion: '' } },
  mcp: { version: process.env.NUXT_PUBLIC_APP_VERSION || process.env.APP_VERSION || '0.0.0' },`,
  ],
  [
    "a NUXT_ variable that no runtimeConfig key declares",
    `runtimeConfig: { public: { apiBase: '' } },
  uiPro: { license: process.env.NUXT_UI_PRO_LICENSE },`,
  ],
  [
    "process.env passed as a whole",
    `runtimeConfig: { public: { directusUrl: '' } },
  apollo: { endpoint: resolveEndpoint(process.env, process.env.NUXT_PUBLIC_DIRECTUS_URL) },`,
  ],
  [
    "reads inside hook functions",
    `runtimeConfig: { public: { directusUrl: '' } },
  hooks: { 'nitro:config'(config) { config.url = process.env.NUXT_PUBLIC_DIRECTUS_URL } },`,
  ],
  [
    "non-runtime variables",
    `runtimeConfig: { public: { directusUrl: '' } },
  nitro: { preset: process.env.NITRO_PRESET_NAME_UNUSED ?? process.env.DEPLOY_PRESET },
  devtools: { enabled: process.env.NODE_ENV !== 'production' },`,
  ],
])("does not report %s", async (_name, properties) => {
  const result = await run(`export default defineNuxtConfig({
  ${properties}
})`);

  expect(result.diagnostics).toHaveLength(0);
});

test("does not report a fallback through a top-level binding", async () => {
  const result = await run(`
const engineUrl = process.env.NUXT_PUBLIC_ENGINE_URL
  || process.env.QUIVER_ENGINE_URL
  || ''

export default defineNuxtConfig({
  runtimeConfig: { public: { engineUrl } },
  openFetch: { clients: { api: { baseURL: engineUrl } } },
})
`);

  expect(result.diagnostics).toHaveLength(0);
});

test("only checks nuxt.config files", async () => {
  const result = await run(
    `export default defineNuxtConfig({
  runtimeConfig: { public: { directusUrl: '' } },
  apollo: { endpoint: process.env.NUXT_PUBLIC_DIRECTUS_URL },
})`,
    "config/other.config.ts",
  );

  expect(result.diagnostics).toHaveLength(0);
});
