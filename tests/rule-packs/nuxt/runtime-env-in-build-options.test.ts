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

test("does not treat a module option named runtimeConfig as Nuxt runtime config", async () => {
  const result = await run(`export default defineNuxtConfig({
  myModule: { runtimeConfig: { foo: '' } },
  other: { value: process.env.NUXT_FOO },
})`);

  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ["$production", `$production: { runtimeConfig: { foo: '' } },`],
  ["$env", `$env: { staging: { runtimeConfig: { foo: '' } } },`],
  ["nitro", `nitro: { runtimeConfig: { foo: '' } },`],
])("reads runtime config keys declared under %s", async (_name, declaration) => {
  const result = await run(`export default defineNuxtConfig({
  ${declaration}
  other: { value: process.env.NUXT_FOO },
})`);

  expect(result.diagnostics).toHaveLength(1);
});

test("does not report a callback binding that reads the variable when it runs", async () => {
  const result = await run(`
const configure = () => process.env.NUXT_PUBLIC_API_BASE
function onReady() { return process.env.NUXT_PUBLIC_API_BASE }

export default defineNuxtConfig({
  runtimeConfig: { public: { apiBase: '' } },
  hooks: { ready: configure, 'app:resolve': onReady },
  myModule: { resolve: [configure] },
})
`);

  expect(result.diagnostics).toHaveLength(0);
});

test("reports a function binding called while nuxt.config loads", async () => {
  const result = await run(`
function apiBase() { return process.env.NUXT_PUBLIC_API_BASE }

export default defineNuxtConfig({
  runtimeConfig: { public: { apiBase: '' } },
  myModule: { endpoint: apiBase() + '/graphql' },
})
`);

  expect(result.diagnostics).toHaveLength(1);
});

test("reports through a config bound to a variable before export", async () => {
  const result = await run(`
const config = defineNuxtConfig({
  runtimeConfig: { public: { apiBase: '' } },
  myModule: { endpoint: process.env.NUXT_PUBLIC_API_BASE },
})
export default config
`);

  expect(result.diagnostics).toHaveLength(1);
});

test("reports a read spread into a build option", async () => {
  const result = await run(`
const opts = { endpoint: process.env.NUXT_PUBLIC_API_URL }

export default defineNuxtConfig({
  runtimeConfig: { public: { apiUrl: '' } },
  apollo: { ...opts },
})
`);

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain("apollo.endpoint");
});

test.each([
  [
    "a shadowing declaration inside an inline function",
    `endpoint: (() => { const apiBase = 'fixed'; return apiBase })(),`,
  ],
  ["a callback returned from a called function", `endpoint: deferred(),`],
  ["a parameter that shadows a top-level binding", `endpoint: withBase('fixed'),`],
  ["a callback nested in a bound object", `hooks: handlers,`],
])("does not report %s", async (_name, option) => {
  const result = await run(`
const apiBase = process.env.NUXT_PUBLIC_API_BASE
function deferred() { return () => process.env.NUXT_PUBLIC_API_BASE }
function withBase(apiBase) { return apiBase + '/graphql' }
const handlers = { ready: () => process.env.NUXT_PUBLIC_API_BASE }

export default defineNuxtConfig({
  runtimeConfig: { public: { apiBase: '' } },
  myModule: { ${option} },
})
`);

  expect(result.diagnostics).toHaveLength(0);
});

test("reports a module option that is itself named runtimeConfig", async () => {
  const result = await run(`export default defineNuxtConfig({
  runtimeConfig: { foo: '' },
  myModule: { runtimeConfig: { endpoint: process.env.NUXT_FOO } },
})`);

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain("myModule.runtimeConfig.endpoint");
});

test("does not report reads from a local process binding", async () => {
  const result = await run(`
const process = { env: { NUXT_PUBLIC_API_BASE: 'fixed' } }

export default defineNuxtConfig({
  runtimeConfig: { public: { apiBase: '' } },
  myModule: { endpoint: process.env.NUXT_PUBLIC_API_BASE },
})
`);

  expect(result.diagnostics).toHaveLength(0);
});

test("reads runtime config keys introduced through a spread", async () => {
  const result = await run(`
const defaults = { public: { apiBase: '' } }

export default defineNuxtConfig({
  runtimeConfig: { ...defaults },
  myModule: { endpoint: process.env.NUXT_PUBLIC_API_BASE },
})
`);

  expect(result.diagnostics).toHaveLength(1);
});

test("reports a read inside an array spread into a build option", async () => {
  const result = await run(`
const extra = [['some-module', { url: process.env.NUXT_PUBLIC_SITE_URL }]]

export default defineNuxtConfig({
  runtimeConfig: { public: { siteUrl: '' } },
  modules: ['other', ...extra],
})
`);

  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["a module shim", `import process from './process-shim'`, 0],
  ["node:process", `import process from 'node:process'`, 1],
])("handles process imported from %s", async (_name, importLine, count) => {
  const result = await run(`${importLine}

export default defineNuxtConfig({
  runtimeConfig: { public: { apiBase: '' } },
  myModule: { endpoint: process.env.NUXT_PUBLIC_API_BASE },
})
`);

  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["version2URL", "NUXT_VERSION2URL"],
  ["siteURL", "NUXT_SITE_URL"],
  ["oauth2ClientId", "NUXT_OAUTH2_CLIENT_ID"],
])("maps runtimeConfig.%s to %s like Nitro", async (key, name) => {
  const result = await run(`export default defineNuxtConfig({
  runtimeConfig: { ${key}: '' },
  myModule: { value: process.env.${name} },
})`);

  expect(result.diagnostics).toHaveLength(1);
});
