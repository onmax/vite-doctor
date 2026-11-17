import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import {
  declareNitroDependency,
  preferNitroH3Import,
} from "../../../src/rule-packs/nitro/rules/index.ts";

const H3_NAMES = ["HTTPError", "createError", "defineEventHandler", "defineHandler", "getQuery"];

/** An installed Nitro 3 whose `nitro/h3` re-exports its own h3 v2, as Nitro publishes it. */
function installedNitro(base = "", names = H3_NAMES): Record<string, string> {
  const prefix = base ? `${base}/` : "";
  return {
    [`${prefix}node_modules/nitro/package.json`]: JSON.stringify({
      name: "nitro",
      version: "3.0.261103-rc",
      exports: { ".": "./dist/index.mjs", "./h3": "./lib/h3.mjs" },
    }),
    [`${prefix}node_modules/nitro/lib/h3.mjs`]: 'export * from "h3";\n',
    [`${prefix}node_modules/nitro/node_modules/h3/package.json`]: JSON.stringify({
      name: "h3",
      version: "2.0.8",
      exports: {
        ".": { node: "./dist/_entries/node.mjs", default: "./dist/_entries/generic.mjs" },
      },
    }),
    [`${prefix}node_modules/nitro/node_modules/h3/dist/_entries/generic.mjs`]: `import { ${names.join(", ")} } from "../h3.mjs";\nexport { ${names.join(", ")} };\n`,
    [`${prefix}node_modules/nitro/node_modules/h3/dist/h3.mjs`]: names
      .map((name) => `export function ${name}() {}`)
      .join("\n"),
  };
}

function workspace(packages: Record<string, object>, files: Record<string, string>) {
  return {
    "package.json": JSON.stringify({ private: true, devDependencies: { nitro: "3.0.0" } }),
    "pnpm-workspace.yaml":
      "packages:\n  - packages/*\ncatalogs:\n  nitro-compat:\n    nitro: 3.0.261102-rc || ^3.0.261103-rc\n",
    ...Object.fromEntries(
      Object.entries(packages).map(([root, manifest]) => [
        `${root}/package.json`,
        JSON.stringify(manifest),
      ]),
    ),
    ...files,
  };
}

const blob = {
  name: "@acme/blob",
  exports: { ".": "./dist/index.mjs" },
  dependencies: { h3: "^2.0.8" },
  peerDependencies: { nitro: "catalog:nitro-compat" },
};

describe("nitro/h3/prefer-nitro-h3", () => {
  test("reports H3 value imports in Nitro 3 server routes and rewrites them to nitro/h3", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: {
        ...installedNitro(),
        "routes/api/users.get.ts": `import { defineHandler, getQuery, type H3Event } from "h3"
export default defineHandler((event: H3Event) => getQuery(event))`,
      },
    });

    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic).toMatchObject({
      code: "NITRO0027",
      ruleId: preferNitroH3Import.meta.id,
      range: { line: 1 },
    });
    expect(diagnostic!.fix).toMatchObject({ kind: "safe", edits: [{ text: "nitro/h3" }] });
    const source = result.diagnostics[0]!.fix!.edits[0]!;
    const text = `import { defineHandler, getQuery, type H3Event } from "h3"`;
    expect(text.slice(source.range.start, source.range.end)).toBe("h3");
  });

  test("reports H3 imports in Nuxt 5 server code", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nuxt",
      dependencies: { nuxt: "5.0.0", nitro: "3.0.0" },
      files: {
        "server/utils/errors.ts": 'export { createError } from "h3"',
        "server/api/ping.get.ts":
          'import * as h3 from "h3"\nexport default h3.defineHandler(() => "pong")',
      },
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "NITRO0027",
      "NITRO0027",
    ]);
  });

  test("reports a package that runs on Nitro 3 and imports H3 from h3", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: workspace(
        { "packages/blob": blob },
        {
          ...installedNitro("packages/blob"),
          "packages/blob/src/ensure.ts": `import { createError } from "h3"
export function ensure(value: unknown) { if (!value) throw createError({ status: 404 }) }`,
          "packages/blob/src/ensure.test.ts": 'import { createError } from "h3"\ncreateError({})',
        },
      ),
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
      expect.stringMatching(/packages\/blob\/src\/ensure\.ts$/),
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "NITRO0027",
      fix: { kind: "safe", edits: [{ text: "nitro/h3" }] },
    });
    expect(result.diagnostics[0]!.why).toContain("NUXT_B9003");
  });

  test("suggests nitro/h3 without an edit when the installed Nitro does not prove the names", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: workspace(
        { "packages/blob": blob },
        {
          ...installedNitro("packages/blob", ["createError"]),
          "packages/blob/src/legacy.ts": 'import { createError, sendRedirect } from "h3"',
          "packages/blob/src/default.ts": 'import h3 from "h3"',
        },
      ),
    });

    expect(result.diagnostics).toHaveLength(2);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code).toBe("NITRO0027");
      expect(diagnostic.fix ?? null).toBeNull();
    }
  });

  test("suggests nitro/h3 without an edit when Nitro is not installed", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: {
        "routes/index.ts":
          'import { defineHandler } from "h3"\nexport default defineHandler(() => "ok")',
      },
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.fix ?? null).toBeNull();
  });

  test("keeps h3 imports valid on Nitro 2", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitropack: "2.13.4" },
      files: {
        "routes/index.ts":
          'import { defineEventHandler } from "h3"\nexport default defineEventHandler(() => "ok")',
      },
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("ignores type-only imports, client code and plain H3 packages", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nuxt",
      dependencies: { nuxt: "5.0.0", nitro: "3.0.0" },
      files: {
        ...workspace(
          {
            // A plain H3 server with no Nitro.
            "packages/api": {
              name: "@acme/api",
              exports: { ".": "./dist/index.mjs" },
              dependencies: { h3: "^2.0.8" },
            },
            // Nitro only for its own tests, so its server builds its own H3 app.
            "packages/internal": {
              name: "@acme/internal",
              exports: { ".": "./dist/index.mjs" },
              dependencies: { h3: "^2.0.8" },
              devDependencies: { nitro: "^3.0.0" },
            },
            // Supports Nitro 2 consumers, which have no nitro/h3.
            "packages/compat": {
              name: "@acme/compat",
              exports: { ".": "./dist/index.mjs" },
              peerDependencies: { nitro: "^2.0.0 || ^3.0.0" },
            },
          },
          {
            "packages/api/src/server.ts": 'import { H3 } from "h3"\nexport const app = new H3()',
            "packages/internal/src/runtime/vercel-hosted.ts":
              'import { H3 } from "h3"\nexport const app = new H3()',
            "packages/compat/src/errors.ts": 'export { createError } from "h3"',
          },
        ),
        "package.json": JSON.stringify({ dependencies: { nuxt: "5.0.0", nitro: "3.0.0" } }),
        "server/api/types.ts": `import type { H3Event } from "h3"
import { type EventHandler } from "h3"
export type { H3Event, EventHandler }
export type { HTTPError } from "h3"`,
        "app/composables/use-error.ts":
          'import { createError } from "h3"\nexport const useError = () => createError({})',
      },
    });

    expect(result.diagnostics).toEqual([]);
  });
});

describe("nitro/dependencies/declare-nitro", () => {
  test("reports a published package that imports nitro/h3 without declaring nitro", async () => {
    const result = await runRuleFixture({
      rule: declareNitroDependency,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: workspace(
        {
          "packages/realtime": {
            name: "@acme/realtime",
            exports: { ".": "./dist/index.mjs" },
            devDependencies: { nitro: "^3.0.0" },
          },
          "packages/blob": blob,
        },
        {
          "packages/realtime/src/server.ts": `import { HTTPError } from "nitro/h3"
import { defineHandler } from "nitro/h3"
export const handler = defineHandler(() => { throw new HTTPError("no") })`,
          "packages/blob/src/ensure.ts": 'import { createError } from "nitro/h3"',
        },
      ),
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "NITRO0028",
      ruleId: declareNitroDependency.meta.id,
      file: expect.stringMatching(/packages\/realtime\/src\/server\.ts$/),
      range: { line: 1 },
    });
    expect(result.diagnostics[0]!.why).toContain("@acme/realtime");
    expect(result.diagnostics[0]!.why).toContain("devDependencies");
  });

  test("ignores Nuxt layers, private packages, apps, tests and type-only imports", async () => {
    const result = await runRuleFixture({
      rule: declareNitroDependency,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: {
        ...workspace(
          {
            "packages/docs": {
              name: "@acme/docs",
              exports: { ".": "./dist/index.mjs" },
              peerDependencies: { nuxt: ">=5.0.0-0" },
            },
            "packages/console": { name: "@acme/console", private: true },
            "packages/types": { name: "@acme/types", exports: { ".": "./dist/index.mjs" } },
          },
          {
            "packages/docs/server/api/search.ts": 'import { defineHandler } from "nitro/h3"',
            "packages/console/src/server.ts": 'import { defineHandler } from "nitro/h3"',
            "packages/types/src/index.ts":
              'import type { H3Event } from "nitro/h3"\nexport type { NitroConfig } from "nitro/types"',
            "packages/types/test/server.test.ts": 'import { defineHandler } from "nitro/h3"',
          },
        ),
        "routes/index.ts": 'import { defineHandler } from "nitro/h3"',
      },
    });

    expect(result.diagnostics).toEqual([]);
  });
});
