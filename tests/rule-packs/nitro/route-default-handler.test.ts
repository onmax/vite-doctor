import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { requireDefaultHandler } from "../../../src/rule-packs/nitro/rules/index.ts";

const helper = "export function getDb() {\n  return createDb()\n}\n";
const handler = "export default defineEventHandler(() => 'ok')\n";

async function codes(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  const result = await runRuleFixture({
    rule: requireDefaultHandler,
    framework,
    dependencies,
    files,
  });
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe("NITRO0019 route file without a default handler", () => {
  test.each(["server/api/_db.ts", "server/routes/feed/helpers.mjs", "server/api/(admin)/utils.js"])(
    "reports helper module %s in a Nuxt server route directory",
    async (file) => {
      expect(await codes({ [file]: helper })).toEqual(["NITRO0019"]);
    },
  );

  test("reports the resolved route and the helper names", async () => {
    const result = await runRuleFixture({
      rule: requireDefaultHandler,
      framework: "nuxt",
      files: { "server/api/users/[id].get.ts": helper },
    });
    const [diagnostic] = result.diagnostics;
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("/api/users/:id route");
    expect(diagnostic?.message).toContain("getDb");
    expect(diagnostic?.suggestion).toContain("server/utils/");
  });

  test("reports type-only route modules", async () => {
    expect(
      await codes({ "server/routes/types.ts": "export interface User { id: string }" }),
    ).toEqual(["NITRO0019"]);
  });

  test.each([
    ["default handler", handler],
    [
      "default export specifier",
      "const handler = defineEventHandler(() => 1)\nexport { handler as default }",
    ],
    ["default re-export", "export { default } from '../../handlers/users'"],
    ["CommonJS export", "module.exports = defineEventHandler(() => 1)"],
    ["TypeScript export assignment", "export = defineEventHandler(() => 1)"],
    ["WebSocket handler", "export default defineWebSocketHandler({ open() {} })"],
    [
      "lazy handler",
      "export default defineLazyEventHandler(async () => defineEventHandler(() => 1))",
    ],
  ])("accepts a route with a %s", async (_name, source) => {
    expect(await codes({ "server/api/users.ts": source })).toEqual([]);
  });

  test.each([
    "server/utils/db.ts",
    "server/middleware/auth.ts",
    "server/plugins/db.ts",
    "server/lib/db.ts",
    "server/api.ts",
    "app/utils/api/db.ts",
    "server/api/-db.ts",
    "server/api/db.d.ts",
    "server/api/db.stories.ts",
  ])("ignores %s in Nuxt projects", async (file) => {
    expect(await codes({ [file]: helper })).toEqual([]);
  });

  test("follows the server directory from the Nuxt manifest", async () => {
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
      layers: [{ root: ".", serverDir: "backend", priority: 0 }],
      aliases: {},
      routeRules: {},
      serverHandlers: [],
      modules: [],
    });
    expect(
      await codes({
        ".nuxt/doctor.manifest.json": manifest,
        "backend/api/_db.ts": helper,
        "server/api/_db.ts": helper,
      }),
    ).toEqual(["NITRO0019"]);
  });

  test("follows a literal Nuxt serverDir option", async () => {
    expect(
      await codes({
        "nuxt.config.ts": "export default defineNuxtConfig({ serverDir: 'backend' })",
        "backend/routes/_db.ts": helper,
        "server/routes/_db.ts": helper,
      }),
    ).toEqual(["NITRO0019"]);
  });

  test("treats app/server as a server directory only before Nuxt 4", async () => {
    const files = { "app/server/api/_db.ts": helper };
    expect(await codes(files)).toEqual([]);
    expect(await codes(files, "nuxt", { nuxt: "3.17.0" })).toEqual(["NITRO0019"]);
  });
});

describe("NITRO0019 in standalone Nitro", () => {
  test("uses the Nitro 2 root as the default server directory", async () => {
    expect(
      await codes(
        { "api/_db.ts": helper, "routes/_db.ts": helper, "server/api/_db.ts": helper },
        "nitro",
      ),
    ).toEqual(["NITRO0019", "NITRO0019"]);
  });

  test("follows a literal Nitro 2 srcDir", async () => {
    expect(
      await codes(
        {
          "nitro.config.ts": "export default defineNitroConfig({ srcDir: 'server' })",
          "api/_db.ts": helper,
          "server/api/_db.ts": helper,
        },
        "nitro",
      ),
    ).toEqual(["NITRO0019"]);
  });

  test("does not scan Nitro 3 routes unless serverDir is enabled", async () => {
    const nitro3 = { nitro: "3.0.0-beta.1", h3: "2.0.0-beta.1" };
    expect(
      await codes({ "routes/_db.ts": helper, "server/routes/_db.ts": helper }, "nitro", nitro3),
    ).toEqual([]);
    const result = await runRuleFixture({
      rule: requireDefaultHandler,
      framework: "nitro",
      dependencies: nitro3,
      files: {
        "nitro.config.ts":
          "export default defineConfig({ serverDir: './server', output: { serverDir: '.output/srv' } })",
        "routes/_db.ts": helper,
        "server/routes/_db.ts": helper,
      },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
      expect.stringMatching(/server\/routes\/_db\.ts$/),
    ]);
    expect(result.diagnostics[0]?.suggestion).toContain("defineHandler()");
  });

  test("resolves serverDir: true to server/ in Nitro 3", async () => {
    expect(
      await codes(
        {
          "nitro.config.ts": "export default defineConfig({ serverDir: true })",
          "server/api/_db.ts": helper,
        },
        "nitro",
        { nitro: "3.0.0-beta.1" },
      ),
    ).toEqual(["NITRO0019"]);
  });
});

describe("NITRO0020 route file with extra runtime exports", () => {
  test("reports named runtime exports next to the handler", async () => {
    const result = await runRuleFixture({
      rule: requireDefaultHandler,
      framework: "nuxt",
      files: {
        "server/api/users.get.ts": `${helper}export const PAGE_SIZE = 20\n${handler}`,
      },
    });
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity])).toEqual([
      ["NITRO0020", "warn"],
      ["NITRO0020", "warn"],
    ]);
    expect(result.diagnostics[0]?.suggestion).toContain("server/utils/");
  });

  test.each([
    ["named re-export", "export { getDb } from '../utils/db'"],
    ["star re-export", "export * from '../utils/db'"],
    ["runtime enum", "export enum Role { Admin }"],
    ["class", "export class Repo {}"],
  ])("reports a %s", async (_name, source) => {
    expect(await codes({ "server/api/users.ts": `${source}\n${handler}` })).toEqual(["NITRO0020"]);
  });

  test.each([
    ["type alias", "export type User = { id: string }"],
    ["interface", "export interface User { id: string }"],
    ["type specifiers", "type User = { id: string }\nexport type { User }"],
    ["inline type specifier", "type User = { id: string }\nexport { type User }"],
    ["type re-export", "export type * from '../utils/types'"],
    ["const enum", "export const enum Role { Admin }"],
    ["ambient declaration", "export declare const version: string"],
  ])("allows a %s", async (_name, source) => {
    expect(await codes({ "server/api/users.ts": `${source}\n${handler}` })).toEqual([]);
  });

  test("allows naming the default-exported handler", async () => {
    expect(
      await codes({
        "server/api/users.ts":
          "export const handler = defineEventHandler(() => 1)\nexport default handler",
      }),
    ).toEqual([]);
  });

  test("ignores named exports outside route directories", async () => {
    expect(
      await codes({
        "server/middleware/auth.ts": `${helper}${handler}`,
        "server/utils/db.ts": helper,
      }),
    ).toEqual([]);
  });
});

describe("route classification evidence", () => {
  test.each([
    "// module.exports = handler",
    "/* exports.default = handler */",
    "const text = 'module.exports'",
    "const text = `exports.default`",
    "module.exports.extra = 1",
    "console.log(module.exports)",
  ])("does not accept a textual CommonJS mention: %s", async (source) => {
    expect(await codes({ "server/api/helper.ts": source })).toEqual(["NITRO0019"]);
  });

  test.each([
    "const unrelated = { serverDir: 'fixtures' }; export default defineNuxtConfig({ serverDir: 'backend' })",
    "export default defineNuxtConfig({ serverDir: 'backend' }); const unrelated = { serverDir: process.env.DIR }",
    "export default defineNuxtConfig({ serverDir: 'backend', unrelated: { serverDir: 'fixtures' } })",
  ])("only reads the exported config options: %s", async (config) => {
    const result = await runRuleFixture({
      rule: requireDefaultHandler,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": config,
        "backend/api/helper.ts": helper,
        "fixtures/api/helper.ts": helper,
        "server/api/helper.ts": helper,
      },
    });
    expect(result.diagnostics.map((item) => item.file)).toEqual([
      expect.stringMatching(/backend\/api\/helper.ts$/),
    ]);
  });

  test.each([
    "export default defineNuxtConfig(() => ({ serverDir: 'backend' }))",
    "export default makeConfig({ serverDir: 'backend' })",
    "export default defineNuxtConfig({ ...dynamic })",
    "export default defineNuxtConfig({ [key]: 'backend' })",
    "export default defineNuxtConfig({ nitro: dynamic })",
  ])("does not infer ambiguous config: %s", async (config) => {
    expect(await codes({ "nuxt.config.ts": config, "server/api/helper.ts": helper })).toEqual([]);
  });

  test.each([
    "scanDirs: ['extra']",
    "apiDir: 'endpoints'",
    "routesDir: 'handlers'",
    "scanDirs: dynamic",
  ])("disables partial coverage for %s", async (option) => {
    expect(
      await codes({
        "nuxt.config.ts": `export default defineNuxtConfig({ nitro: { ${option} } })`,
        "server/api/helper.ts": helper,
      }),
    ).toEqual([]);
    expect(
      await codes(
        {
          "nitro.config.ts": `export default defineNitroConfig({ ${option} })`,
          "api/helper.ts": helper,
        },
        "nitro",
      ),
    ).toEqual([]);
  });

  test.each([
    "export default defineConfig(() => ({ plugins: [] }))",
    "export default async () => ({ plugins: [] })",
    "export default makeConfig()",
    "export default { plugins: dynamic, serverDir: 'wrong' }",
    "export default { ...dynamic }",
    "import { nitro } from 'unrelated'; export default { plugins: [nitro({ serverDir: 'wrong' })] }",
  ])("ignores unrelated Vite configuration: %s", async (config) => {
    expect(
      await codes(
        {
          "nitro.config.ts": "export default { serverDir: 'backend' }",
          "vite.config.ts": config,
          "backend/api/helper.ts": helper,
        },
        "nitro",
        { nitro: "3.0.0-beta.1" },
      ),
    ).toEqual(["NITRO0019"]);
  });

  test.each([
    "import { nitro as server } from 'nitro/vite'; export default { plugins: [server({ serverDir: 'backend' })] }",
  ])("reads only the Vite Nitro integration: %s", async (config) => {
    expect(
      await codes(
        {
          "vite.config.ts": config,
          "backend/api/helper.ts": helper,
        },
        "nitro",
        { nitro: "3.0.0-beta.1" },
      ),
    ).toEqual(["NITRO0019"]);
  });

  test.each(["import { nitro } from 'nitro/vite'; export default { plugins: [nitro(dynamic)] }"])(
    "retains ambiguity from a proven Nitro integration: %s",
    async (config) => {
      expect(
        await codes(
          {
            "nitro.config.ts": "export default { serverDir: 'backend' }",
            "vite.config.ts": config,
            "backend/api/helper.ts": helper,
          },
          "nitro",
          { nitro: "3.0.0-beta.1" },
        ),
      ).toEqual([]);
    },
  );

  test("ignores an unwrappable Vite config when Nitro config is authoritative", async () => {
    expect(
      await codes(
        {
          "nitro.config.ts": "export default { serverDir: 'backend' }",
          "vite.config.ts":
            "import { nitro } from 'nitro/vite'; export default defineConfig(() => ({ plugins: [nitro(dynamic)] }))",
          "backend/api/helper.ts": helper,
        },
        "nitro",
        { nitro: "3.0.0-beta.1" },
      ),
    ).toEqual(["NITRO0019"]);
  });

  test("ignores a Nitro key without an active Vite plugin", async () => {
    expect(
      await codes(
        {
          "vite.config.ts": "export default { nitro: dynamic, plugins: dynamic }",
          "backend/api/helper.ts": helper,
        },
        "nitro",
        { nitro: "3.0.0-beta.1" },
      ),
    ).toEqual([]);
  });

  test("reads the Nitro plugin config in Vite", async () => {
    expect(
      await codes(
        {
          "vite.config.ts":
            "import { nitro } from 'nitro/vite'; export default defineConfig({ plugins: [nitro({ serverDir: 'backend' })] })",
          "backend/api/helper.ts": helper,
        },
        "nitro",
        { nitro: "3.0.0-beta.1" },
      ),
    ).toEqual(["NITRO0019"]);
  });

  test.each([
    ["dynamic", "{ serverDir: 'backend' }", ["NITRO0019"]],
    ["{ scanDirs: ['extra'] }", "{ serverDir: 'backend' }", ["NITRO0019"]],
    ["{ serverDir: 'backend' }", "dynamic", []],
    ["{ serverDir: 'backend' }", "{ serverDir: 'backend', scanDirs: ['extra'] }", []],
  ])(
    "uses the effective Vite nitro property: %s then %s",
    async (shadowed, effective, expected) => {
      expect(
        await codes(
          {
            "vite.config.ts": `import { nitro } from 'nitro/vite'; export default { plugins: [nitro()], nitro: ${shadowed}, nitro: ${effective} }`,
            "backend/api/helper.ts": helper,
          },
          "nitro",
          { nitro: "3.0.0-beta.1" },
        ),
      ).toEqual(expected);
    },
  );

  test("uses the effective Vite plugins property", async () => {
    expect(
      await codes(
        {
          "vite.config.ts":
            "import { nitro } from 'nitro/vite'; export default { plugins: [nitro({ serverDir: 'backend' })], plugins: [] }",
          "backend/api/helper.ts": helper,
        },
        "nitro",
        { nitro: "3.0.0-beta.1" },
      ),
    ).toEqual([]);
  });
});
