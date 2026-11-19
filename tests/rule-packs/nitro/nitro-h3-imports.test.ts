import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
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

/** A Nuxt module package built by the module builder, declaring `nuxt` as a peer when given a range. */
function nuxtModulePackage(name: string, nuxtPeer?: string) {
  return {
    name,
    type: "module",
    exports: { ".": "./dist/module.mjs" },
    dependencies: { "@nuxt/kit": "^5.0.0", h3: "^2.0.8" },
    ...(nuxtPeer ? { peerDependencies: { nuxt: nuxtPeer } } : {}),
    devDependencies: { "@nuxt/module-builder": "^1.0.0", nuxt: "^5.0.0" },
  };
}

const blob = {
  name: "@acme/blob",
  exports: { ".": "./dist/index.mjs" },
  dependencies: { h3: "^2.0.8" },
  peerDependencies: { nitro: "catalog:nitro-compat" },
};

describe("nitro/h3/prefer-nitro-h3", () => {
  test("does not automatically migrate legacy APIs even when their names exist", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nuxt",
      dependencies: { nuxt: "5.0.0", nitro: "3.0.0" },
      files: {
        ...installedNitro("", ["defineEventHandler", "readBody", "sendWebResponse"]),
        "server/api/body.ts": `import { defineEventHandler, readBody } from "h3"
export default defineEventHandler(async event => {
  await readBody(event)
  return await readBody(event)
})`,
        "server/api/response.ts": `import { sendWebResponse } from "h3"
export default event => sendWebResponse(event, new Response("ok"))`,
      },
    });
    expect(result.diagnostics).toHaveLength(2);
    for (const diagnostic of result.diagnostics) expect(diagnostic.fix ?? null).toBeNull();
  });

  test("broad serverDir respects package ownership and excludes build scripts", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitro: "3.0.0" },
      files: {
        ...workspace(
          {
            "packages/plain": {
              name: "plain-h3",
              exports: "./src/index.ts",
              dependencies: { h3: "^2.0.0" },
            },
            "packages/compat": {
              name: "compat",
              exports: "./src/index.ts",
              peerDependencies: { nitro: "^2.0.0 || ^3.0.0" },
              devDependencies: { nitro: "^3.0.0" },
            },
          },
          {
            "packages/plain/src/index.ts": 'import { H3 } from "h3"',
            "packages/compat/server/api/index.ts": 'import { createError } from "h3"',
          },
        ),
        "nitro.config.ts": 'export default { serverDir: "." }',
        "scripts/build-fixture.ts": 'import { H3 } from "h3"',
        "routes/index.ts": 'import { defineHandler } from "h3"',
      },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
      expect.stringMatching(/routes\/index\.ts$/),
    ]);
  });

  test("reports H3 value imports in Nitro 3 server routes as manual migrations", async () => {
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
    expect(diagnostic!.fix ?? null).toBeNull();
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

  test.each([undefined, "^3.0.0", "^2.0.0 || ^3.0.0"])(
    "preserves Nuxt layer server evidence with Nitro peer %s",
    async (nitroPeer) => {
      const result = await runRuleFixture({
        rule: preferNitroH3Import,
        framework: "nuxt",
        dependencies: { nuxt: "5.0.0", nitro: "3.0.0" },
        files: {
          "package.json": JSON.stringify({
            name: "@acme/server-layer",
            type: "module",
            main: "./nuxt.config.ts",
            peerDependencies: nitroPeer ? { nitro: nitroPeer } : {},
            devDependencies: { nuxt: "^5.0.0", nitro: "^3.0.0" },
          }),
          "nuxt.config.ts": "export default defineNuxtConfig({})",
          "server/api/example.ts": 'import { createError } from "h3"',
          "src/index.ts": 'import { createError } from "h3"',
        },
      });
      expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual(
        nitroPeer?.startsWith("^2") ? [] : [expect.stringMatching(/server\/api\/example\.ts$/)],
      );
    },
  );

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
    });
    expect(result.diagnostics[0]!.fix ?? null).toBeNull();
    expect(result.diagnostics[0]!.why).toContain("NUXT_B9003");
  });

  test("reports server runtime that a Nuxt 5 module package registers into Nitro", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc", nuxt: "5.0.0" },
      files: workspace(
        {
          "packages/docs": nuxtModulePackage("@acme/docs", ">=5.0.0-0"),
          // A library whose Nuxt module is the `./nuxt` subpath, not the package entry.
          "packages/content": {
            name: "@acme/content",
            type: "module",
            exports: {
              ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
              "./nuxt": { types: "./dist/nuxt.d.ts", import: "./dist/nuxt.js" },
            },
            dependencies: { "@nuxt/kit": "^5.0.0" },
            peerDependencies: { nuxt: ">=5.0.0-0" },
          },
        },
        {
          "packages/content/src/index.ts": 'export { createError } from "h3"',
          "packages/content/src/nuxt.ts": `import { defineNuxtModule } from "@nuxt/kit"
const contentModule = defineNuxtModule({ setup() {} })
export default contentModule`,
          "packages/content/src/runtime/server/raw.ts":
            'import { defineHandler } from "h3"\nexport default defineHandler(() => "raw")',
          "packages/docs/src/module.ts": `import { addServerHandler, addServerPlugin, createResolver, defineNuxtModule } from "@nuxt/kit"
import { createError } from "h3"
export default defineNuxtModule({
  setup() {
    const resolver = createResolver(import.meta.url)
    if (!resolver) throw createError({ status: 500 })
    addServerHandler({ route: "/api/page", handler: resolver.resolve("./runtime/server/page.js") })
    addServerPlugin(resolver.resolve("./server/plugin"))
  },
})`,
          "packages/docs/src/runtime/server/page.ts":
            'import { defineHandler } from "h3"\nexport default defineHandler(() => "page")',
          "packages/docs/src/server/plugin.ts":
            'import { definePlugin } from "nitro"\nimport { getQuery } from "h3"\nexport default definePlugin(() => getQuery)',
          "packages/docs/src/runtime/app/plugin.ts":
            'import { createError } from "h3"\nexport default () => createError({})',
          "packages/docs/src/utils.ts": 'export { createError } from "h3"',
        },
      ),
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.file).sort()).toEqual([
      expect.stringMatching(/packages\/content\/src\/runtime\/server\/raw\.ts$/),
      expect.stringMatching(/packages\/docs\/src\/runtime\/server\/page\.ts$/),
      expect.stringMatching(/packages\/docs\/src\/server\/plugin\.ts$/),
    ]);
    expect(result.diagnostics[1]!.why).toContain("@acme/docs");
  });

  test("keeps h3 imports in Nuxt module server runtime that also supports Nuxt 4", async () => {
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc", nuxt: "5.0.0" },
      files: workspace(
        {
          "packages/compat": nuxtModulePackage("@acme/compat", "^4.0.0 || ^5.0.0"),
          "packages/unknown": nuxtModulePackage("@acme/unknown"),
          "packages/nightly": nuxtModulePackage("@acme/nightly", "npm:nuxt-nightly@4x"),
        },
        {
          "packages/compat/src/module.ts":
            'import { defineNuxtModule } from "@nuxt/kit"\nexport default defineNuxtModule({ setup() {} })',
          "packages/compat/src/runtime/server/page.ts":
            'import { defineEventHandler } from "h3"\nexport default defineEventHandler(() => "page")',
          "packages/unknown/src/module.ts":
            'import { defineNuxtModule } from "@nuxt/kit"\nexport default defineNuxtModule({ setup() {} })',
          "packages/unknown/src/runtime/server/page.ts":
            'import { defineEventHandler } from "h3"\nexport default defineEventHandler(() => "page")',
          "packages/nightly/src/module.ts":
            'import { defineNuxtModule } from "@nuxt/kit"\nexport default defineNuxtModule({ setup() {} })',
          "packages/nightly/src/runtime/server/page.ts": 'export { defineEventHandler } from "h3"',
        },
      ),
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("uses the selected handler variant and proven Kit resolver paths", async () => {
    const source = 'export { defineHandler } from "h3"';
    const result = await runRuleFixture({
      rule: preferNitroH3Import,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: workspace(
        { "packages/docs": nuxtModulePackage("@acme/docs", ">=5.0.0-0") },
        {
          "packages/docs/src/module.ts": `import { addDevServerHandler, addServerHandler, addNitroPlugin, createResolver as kitResolver, defineNuxtModule } from "@nuxt/kit"
import { fileURLToPath as toPath } from "node:url"
export default defineNuxtModule({ setup() {
  const resolver = kitResolver(import.meta.url)
  addServerHandler({ handler: { nuxt: resolver.resolve('runtime', 'server', 'status'), nitro2: resolver.resolve('./runtime/server/status.legacy') } })
  const { resolve: fromOther } = kitResolver(toPath(new URL('./other/', import.meta.url)))
  addServerHandler({ handler: fromOther('./status.ts') })
  addDevServerHandler({ handler: toPath(new URL('./dev.ts', import.meta.url)) })
  addNitroPlugin(resolver.resolve('runtime/plugin.ts'))
  addServerHandler({ handler: resolver.resolve('./unproven.ts', process.env.HANDLER) })
  function shadowed(resolver: { resolve(path: string): string }) {
    addServerHandler({ handler: resolver.resolve('./unproven.ts') })
  }
} })`,
          ...Object.fromEntries(
            [
              "runtime/server/status.ts",
              "runtime/server/status.legacy.ts",
              "other/status.ts",
              "status.ts",
              "dev.ts",
              "runtime/plugin.ts",
              "unproven.ts",
            ].map((file) => [`packages/docs/src/${file}`, source]),
          ),
        },
      ),
    });
    expect(result.diagnostics.map(({ file }) => file).sort()).toEqual([
      expect.stringMatching(/dev\.ts$/),
      expect.stringMatching(/other\/status\.ts$/),
      expect.stringMatching(/runtime\/plugin\.ts$/),
      expect.stringMatching(/runtime\/server\/status\.ts$/),
    ]);
  });

  test("tracks module entry discovery across cached runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-nitro-module-"));
    const modulePath = "packages/docs/src/module.ts";
    const moduleSource =
      'import { defineNuxtModule } from "@nuxt/kit"\nexport default defineNuxtModule({ setup() {} })';
    const options = {
      root,
      framework: "nitro" as const,
      runtimeTarget: { nitro: "3.0.0", h3: "2.0.8" },
      rules: preferNitroH3Import.meta.id,
      cache: true,
    };
    try {
      for (const [file, text] of Object.entries(
        workspace(
          { "packages/docs": nuxtModulePackage("@acme/docs", ">=5.0.0-0") },
          {
            "packages/docs/nuxt.config.ts": "export default {}",
            [modulePath]: moduleSource,
            "packages/docs/src/runtime/server/page.ts": 'export { defineHandler } from "h3"',
          },
        ),
      )) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
      }
      expect((await runViteDoctor(options)).diagnostics).toHaveLength(1);
      writeFileSync(join(root, modulePath), "export default {}\n");
      expect((await runViteDoctor(options)).diagnostics).toEqual([]);
      rmSync(join(root, modulePath));
      expect((await runViteDoctor(options)).diagnostics).toEqual([]);
      writeFileSync(join(root, modulePath), moduleSource);
      expect((await runViteDoctor(options)).diagnostics).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
  test("ignores a named app with Nitro as a build dependency", async () => {
    const result = await runRuleFixture({
      rule: declareNitroDependency,
      framework: "nitro",
      dependencies: { nitro: "3.0.0" },
      files: {
        "package.json": JSON.stringify({
          name: "my-api",
          type: "module",
          scripts: { dev: "nitro dev", build: "nitro build" },
          devDependencies: { nitro: "^3.0.0" },
        }),
        "server.ts":
          'import { defineHandler } from "nitro"; export default defineHandler(() => "ok")',
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

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

  test("reports a package that ships into Nitro with nitro in dependencies instead of peers", async () => {
    const result = await runRuleFixture({
      rule: declareNitroDependency,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: workspace(
        {
          "packages/realtime": {
            name: "@acme/realtime",
            exports: { ".": "./dist/index.mjs" },
            dependencies: { nitro: "catalog:nitro-compat" },
          },
          "packages/docs": {
            ...nuxtModulePackage("@acme/docs", ">=5.0.0-0"),
            optionalDependencies: { nitro: "^3.0.0" },
          },
        },
        {
          "packages/realtime/src/server.ts":
            'import type { H3Event } from "nitro/h3"\nimport { HTTPError } from "nitro/h3"\nimport { useRuntimeConfig } from "nitro/runtime-config"\nexport const fail = (event: H3Event) => new HTTPError(String(useRuntimeConfig(event)))',
          "packages/docs/src/module.ts":
            'import { defineNuxtModule } from "@nuxt/kit"\nexport default defineNuxtModule({ setup() {} })',
          "packages/docs/src/runtime/server/page.ts":
            'import { defineHandler } from "nitro/h3"\nexport default defineHandler(() => "page")',
        },
      ),
    });

    expect(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.file,
        diagnostic.range?.line,
      ]),
    ).toEqual([
      ["NITRO0028", expect.stringMatching(/packages\/docs\/src\/runtime\/server\/page\.ts$/), 1],
      ["NITRO0028", expect.stringMatching(/packages\/realtime\/src\/server\.ts$/), 2],
    ]);
    const realtime = result.diagnostics.find((diagnostic) =>
      diagnostic.why.includes("@acme/realtime"),
    );
    expect(realtime!.why).toContain("dependencies");
    expect(realtime!.suggestion).toContain("peerDependencies");
  });

  test("attributes Nitro build evidence to the package that owns it", async () => {
    const app = {
      name: "@acme/app",
      exports: "./dist/index.js",
      dependencies: { nitro: "^3.0.0" },
    };
    const files = workspace(
      { "packages/app": app, "packages/builder": { name: "@acme/builder" } },
      {
        "packages/app/vite.config.ts":
          'import { nitro } from "nitro/vite"\nexport default { plugins: [nitro({})] }',
        "packages/app/src/entry.ts": 'export { useRuntimeConfig } from "nitro/runtime-config"',
        "packages/builder/index.ts": 'export { createNitro } from "nitro/builder"',
        "src/entry.ts": 'export { useRuntimeConfig } from "nitro/runtime-config"',
      },
    );
    const result = await runRuleFixture({
      rule: declareNitroDependency,
      framework: "nitro",
      files: { ...files, "package.json": JSON.stringify({ ...app, name: "@acme/root" }) },
    });
    expect(result.diagnostics.map(({ why }) => why)).toEqual([
      expect.stringContaining("@acme/root"),
    ]);
  });

  test("keeps Nitro build helpers and standalone H3 out of the peer advice", async () => {
    const result = await runRuleFixture({
      rule: declareNitroDependency,
      framework: "nitro",
      files: {
        "package.json": JSON.stringify({
          name: "@acme/tools",
          exports: "./dist/index.js",
          dependencies: { nitro: "^3.0.0" },
        }),
        "src/preset.ts": 'export { defineConfig as definePreset } from "nitro"',
        "src/server.ts":
          'import { H3, HTTPError } from "nitro/h3"\nexport const app = new H3().get("/", () => { throw new HTTPError("test") })',
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("lets Nitro apps and packages that build their own Nitro depend on nitro", async () => {
    const result = await runRuleFixture({
      rule: declareNitroDependency,
      framework: "nitro",
      dependencies: { nitro: "3.0.261103-rc" },
      files: {
        ...workspace(
          {
            // A deployable Nitro app with a start entry.
            "packages/api": {
              name: "@acme/api",
              main: "./.output/server/index.mjs",
              scripts: { build: "nitro build" },
              dependencies: { nitro: "^3.0.0" },
            },
            // A framework that creates the Nitro its runtime code runs in.
            "packages/start": {
              name: "@acme/start",
              exports: { ".": "./dist/index.mjs", "./server": "./dist/server.mjs" },
              dependencies: { nitro: "^3.0.0" },
            },
            "packages/peer": {
              name: "@acme/peer",
              exports: { ".": "./dist/index.mjs" },
              dependencies: { nitro: "^3.0.0" },
              peerDependencies: { nitro: "^3.0.0" },
            },
          },
          {
            "packages/api/nitro.config.ts": 'export default { serverDir: "./server" }',
            "packages/api/server/routes/index.ts":
              'import { defineHandler } from "nitro/h3"\nexport default defineHandler(() => "ok")',
            "packages/start/src/vite.ts":
              'import { nitro } from "nitro/vite"\nexport const start = () => [nitro()]',
            "packages/start/src/server.ts":
              'import { useRuntimeConfig } from "nitro/runtime-config"\nexport const handler = () => useRuntimeConfig()',
            "packages/peer/src/index.ts": 'export { HTTPError } from "nitro/h3"',
          },
        ),
      },
    });

    expect(result.diagnostics).toEqual([]);
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
