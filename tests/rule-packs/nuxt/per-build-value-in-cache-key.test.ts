import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noPerBuildValueInCacheKey } from "../../../src/rule-packs/nuxt/rules/nuxt/no-per-build-value-in-cache-key.ts";

async function run(body: string, { buildCache = "experimental: { buildCache: true }," } = {}) {
  return runRuleFixture({
    framework: "nuxt",
    rule: noPerBuildValueInCacheKey,
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({
  ${buildCache}
  ${body}
})`,
    },
  });
}

async function runFile(config: string) {
  return runRuleFixture({
    framework: "nuxt",
    rule: noPerBuildValueInCacheKey,
    files: { "nuxt.config.ts": config },
  });
}

test("reports a build time in appConfig and suggests public runtime config", async () => {
  const result = await run(`appConfig: { buildTime: new Date().toISOString() },`);

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("NUXT0091");
  expect(result.diagnostics[0]?.why).toContain("appConfig.buildTime");
  expect(result.diagnostics[0]?.why).toContain("new Date()");
  expect(result.diagnostics[0]?.suggestion).toContain("runtimeConfig.public.buildTime");
});

test.each([
  ["a vite define", `vite: { define: { __BUILD_TIME__: JSON.stringify(Date.now()) } },`],
  [
    "app.head meta",
    `app: { head: { meta: [{ name: 'build', content: String(Math.random()) }] } },`,
  ],
  ["a module option tuple", `modules: [['some-module', { buildId: crypto.randomUUID() }]],`],
  ["a template literal", "appConfig: { label: `built ${new Date()}` },"],
  ["a performance timer", `appConfig: { startedAt: performance.now() },`],
])("reports %s", async (_name, body) => {
  const result = await run(body);

  expect(result.diagnostics).toHaveLength(1);
});

test("follows a top-level binding and a helper called while config loads", async () => {
  const result = await runFile(`
const stamp = () => new Date().toISOString()
const buildTime = stamp()

export default defineNuxtConfig({
  experimental: { buildCache: true },
  appConfig: { buildTime },
})`);

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain("appConfig.buildTime");
});

test("reports randomUUID imported from node:crypto", async () => {
  const result = await runFile(`
import { randomUUID as uuid } from 'node:crypto'

export default defineNuxtConfig({
  experimental: { buildCache: true },
  appConfig: { deployId: uuid() },
})`);

  expect(result.diagnostics).toHaveLength(1);
});

test("reports environment overrides of unhashed keys, which Nuxt still hashes", async () => {
  const result = await run(
    `$production: { runtimeConfig: { public: { buildTime: new Date().toISOString() } } },`,
  );

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.suggestion).toContain("top-level runtimeConfig");
});

test("reports when buildCache is enabled only for production", async () => {
  const result = await run(`appConfig: { buildTime: Date.now() },`, {
    buildCache: "$production: { experimental: { buildCache: true } },",
  });

  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  [
    "top-level runtimeConfig",
    `runtimeConfig: { public: { buildTime: new Date().toISOString() } },`,
  ],
  ["nitro options", `nitro: { prerender: { routes: [String(Date.now())] } },`],
  ["devtools options", `devtools: { timeline: { startedAt: Date.now() } },`],
  ["a hook body", `hooks: { 'build:before': () => { console.log(Date.now()) } },`],
  ["a method body", `appConfig: { now() { return Date.now() } },`],
  ["a fixed date", `appConfig: { launched: new Date('2026-01-01').toISOString() },`],
  ["a calendar year", `appConfig: { year: new Date().getFullYear() },`],
  ["a calendar date", `appConfig: { day: new Date().toISOString().slice(0, 10) },`],
  ["a stable version", `appConfig: { version: process.env.npm_package_version },`],
])("does not report %s", async (_name, body) => {
  const result = await run(body);

  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ["buildCache is not set", ""],
  ["buildCache is false", "experimental: { buildCache: false },"],
  ["buildCache is computed", "experimental: { buildCache: process.env.CI === 'true' },"],
])("does not report when %s", async (_name, buildCache) => {
  const result = await run(`appConfig: { buildTime: new Date().toISOString() },`, { buildCache });

  expect(result.diagnostics).toHaveLength(0);
});

test("does not report a shadowed Date", async () => {
  const result = await runFile(`
import { Date } from './fixed-clock'

export default defineNuxtConfig({
  experimental: { buildCache: true },
  appConfig: { buildTime: new Date().toISOString() },
})`);

  expect(result.diagnostics).toHaveLength(0);
});

function manifest(buildCache: boolean) {
  return JSON.stringify({
    generatedAt: "2999-01-01T00:00:00.000Z",
    nuxtVersion: "4.0.0",
    vueVersion: "3.5.0",
    rootDir: "/fixture",
    srcDir: "app",
    appDir: "app",
    buildDir: ".nuxt",
    autoImports: [],
    components: [],
    layers: [{ root: ".", srcDir: "app", priority: 0 }],
    aliases: {},
    routeRules: {},
    serverHandlers: [],
    buildCache,
  });
}

test.each([
  ["reports", true, "", 1],
  ["does not report", false, "experimental: { buildCache: true },", 0],
])(
  "%s when the Nuxt manifest resolves buildCache to %s",
  async (_name, buildCache, literal, expected) => {
    const result = await runRuleFixture({
      framework: "nuxt",
      rule: noPerBuildValueInCacheKey,
      files: {
        ".nuxt/doctor.manifest.json": manifest(buildCache),
        "nuxt.config.ts": `export default defineNuxtConfig({
  ${literal}
  appConfig: { buildTime: new Date().toISOString() },
})`,
      },
    });

    expect(result.diagnostics).toHaveLength(expected);
  },
);
