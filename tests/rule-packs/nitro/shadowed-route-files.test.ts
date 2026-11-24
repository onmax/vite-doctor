import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { nitroRulePack, noShadowedFileHandler } from "../../../src/rule-packs/nitro/index.ts";

const handler = "export default defineEventHandler(() => 'ok')\n";
const nitro3 = { nitro: "3.0.0-beta.1", h3: "2.0.0-beta.1" };

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  const result = await runRuleFixture({
    rule: noShadowedFileHandler,
    framework,
    dependencies,
    files,
  });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
    why: diagnostic.why,
  }));
}

async function shadowed(...args: Parameters<typeof run>) {
  return (await run(...args)).map((diagnostic) => diagnostic.file);
}

function routeFiles(...paths: string[]) {
  return Object.fromEntries(paths.map((path) => [path, handler]));
}

test("is a recommended Nitro rule", () => {
  expect(nitroRulePack.presets.recommended).toContain(noShadowedFileHandler.meta.id);
});

describe("NITRO0031 route files that resolve to the same route", () => {
  test("reports the file Nitro drops and names the one it keeps", async () => {
    expect(await run(routeFiles("server/api/users.ts", "server/api/users/index.ts"))).toEqual([
      expect.objectContaining({
        code: "NITRO0031",
        file: "server/api/users/index.ts",
        why: expect.stringContaining("same route, method and environment as api/users.ts"),
      }),
    ]);
  });

  test.each([
    [["server/routes/feed.ts", "server/routes/feed.js"], "server/routes/feed.ts"],
    [["server/api/(admin)/stats.get.ts", "server/api/stats.get.ts"], "server/api/stats.get.ts"],
    [
      ["server/api/[id].delete.ts", "server/api/[id]/index.delete.ts"],
      "server/api/[id]/index.delete.ts",
    ],
  ])("reports %j", async (paths, dropped) => {
    expect(await shadowed(routeFiles(...paths))).toEqual([dropped]);
  });

  test("reports standalone Nitro 2 routes", async () => {
    expect(await shadowed(routeFiles("routes/index.ts", "routes/index.js"), "nitro")).toEqual([
      "routes/index.ts",
    ]);
  });

  test("reports Nitro 3 routes", async () => {
    expect(
      await shadowed(
        {
          "nitro.config.ts": "export default defineConfig({ serverDir: true })\n",
          ...routeFiles("server/api/hello.query.ts", "server/api/hello/index.query.ts"),
        },
        "nitro",
        nitro3,
      ),
    ).toEqual(["server/api/hello/index.query.ts"]);
  });

  test.each([
    ["different methods", ["server/api/users.get.ts", "server/api/users.post.ts"]],
    [
      "a method-less handler next to a method handler",
      ["server/api/users.ts", "server/api/users.get.ts"],
    ],
    ["an env-specific handler", ["server/api/users.ts", "server/api/users.dev.ts"]],
    ["the same name in api and routes", ["server/api/users.ts", "server/routes/users.ts"]],
    ["different param names", ["server/api/[id].ts", "server/api/[slug].ts"]],
  ])("stays quiet for %s", async (_name, paths) => {
    expect(await shadowed(routeFiles(...paths))).toEqual([]);
  });

  test("stays quiet for a layer that overrides a route", async () => {
    const manifest = JSON.stringify({
      nuxtVersion: "4.0.0",
      vueVersion: "3.5",
      rootDir: ".",
      srcDir: "app",
      appDir: "app",
      buildDir: ".nuxt",
      autoImportEnabled: true,
      autoImports: [],
      components: [],
      layers: [
        { root: ".", serverDir: "server", priority: 0 },
        { root: "layers/base", serverDir: "layers/base/server", priority: 1 },
      ],
      aliases: {},
      routeRules: {},
      serverHandlers: [],
      modules: [],
    });
    expect(
      await shadowed({
        ".nuxt/doctor.manifest.json": manifest,
        ...routeFiles("server/api/users.ts", "layers/base/server/api/users.ts"),
      }),
    ).toEqual([]);
  });

  test("records an evidence gap for custom ignore patterns", async () => {
    expect(
      await shadowed({
        "nuxt.config.ts": "export default defineNuxtConfig({ ignore: ['server/api/users/**'] })\n",
        ...routeFiles("server/api/users.ts", "server/api/users/index.ts"),
      }),
    ).toEqual([]);
  });
});
