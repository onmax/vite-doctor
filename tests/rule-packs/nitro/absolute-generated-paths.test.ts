import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import {
  nitroRulePack,
  requireAbsoluteGeneratedPaths,
} from "../../../src/rule-packs/nitro/index.ts";
import { getRuleDocuments } from "../../../docs/rules/source.ts";

const ruleId = "nitro/config/require-absolute-generated-paths";
const project = createProjectFixture({ framework: "nuxt", files: { "app/.gitkeep": "" } });
afterAll(() => project.dispose());

async function lines(files: Record<string, string>) {
  const result = await project.run({ rule: requireAbsoluteGeneratedPaths, files });
  return result.diagnostics.map(
    (diagnostic) => `${diagnostic.file.split("/").slice(-2).join("/")}:${diagnostic.range?.line}`,
  );
}

test("is in the Nitro Recommended Preset with documentation", { timeout: 30_000 }, () => {
  expect(nitroRulePack.presets.recommended).toContain(ruleId);
  expect(getRuleDocuments().find((rule) => rule.id === ruleId)?.diagnosticCodes).toEqual([
    "NITRO0025",
  ]);
});

test(
  "runs on Vite library packages of a Nitro workspace under auto, outside their runtime directories",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-nitro-generated-paths-"));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "workspace",
        private: true,
        devDependencies: { nitro: "^3.0.0" },
      }),
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/database/package.json": JSON.stringify({
        name: "@workspace/database",
        peerDependencies: { vite: "*" },
      }),
      "packages/database/src/vite.ts": `import type { Plugin } from "vite"
export function hubDatabase(): Plugin {
  return { name: "hub-database", config: () => ({ nitro: { handlers: [{ handler: ".hub/db.ts", route: "/_db" }] } }) }
}
`,
      "packages/database/server/plugins/register.ts": `import type { NitroApp } from "nitro"
export const routes = [{ handler: "./generated.ts", route: "/x" }]
`,
      "packages/database/app/composables/useRoutes.ts": `import type { Plugin } from "vite"
export const routes = [{ handler: "./generated.ts", route: "/x" }]
`,
    };
    try {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
      }
      const result = await runViteDoctor({ root, cache: false });
      expect(
        result.workspacePackages?.find((item) => item.root === "packages/database")?.framework,
      ).toBe("vite");
      expect(
        result.diagnostics
          .filter((diagnostic) => diagnostic.ruleId === ruleId)
          .map((diagnostic) => [diagnostic.code, diagnostic.file.slice(root.length + 1)]),
      ).toEqual([["NITRO0025", "packages/database/src/vite.ts"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("reports relative generated handlers registered from a Nuxt integration (vitehub database/src/nuxt.ts:379)", async () => {
  const result = await project.run({
    rule: requireAbsoluteGeneratedPaths,
    files: {
      "packages/database/src/nuxt.ts": `import { resolve } from "node:path"
import type { Plugin } from "vite"
const generatedMiddleware = ".vitehub/nitro/database/middleware.ts"
export async function install(config: Record<string, unknown>, root: string) {
  const kit = createNitroServerKit(config)
  kit.addHandler({ handler: generatedMiddleware, middleware: true, route: "/**" }, "start")
  await writeFileIfChanged(resolve(root, generatedMiddleware), "export default () => {}")
}`,
    },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ ruleId, code: "NITRO0025", severity: "warn" });
  expect(result.diagnostics[0]!.why).toContain('".vitehub/nitro/database/middleware.ts"');
  expect(result.diagnostics[0]!.suggestion).toContain("resolve(root, generatedMiddleware)");
});

test("reports relative handlers and plugins in Vite plugin Nitro config (vitehub 085f1d8ef, 46cdded86)", async () => {
  expect(
    await lines({
      "packages/blob/src/vite.ts": `import type { Plugin } from "vite"
const generatedPlugin = ".vitehub/nitro/blob/plugin.ts"
export function hubBlob(): Plugin {
  return {
    name: "hub-blob",
    config() {
      return {
        nitro: {
          plugins: [generatedPlugin],
          handlers: [{ handler: "./.vitehub/blob/serve.ts", route: "/_blob/**" }],
        },
      }
    },
    configResolved(config: any) {
      config.nitro.plugins.push("../generated/plugin.ts")
      config.nitro.handlers.unshift({ handler: ".vitehub/agent/webhook.ts", method: "post", route: "/hooks" })
    },
  }
}`,
      "modules/generated.ts": `import { defineNuxtModule } from "@nuxt/kit"
export default defineNuxtModule({
  setup(_options, nuxt) {
    nuxt.options.nitro.plugins ||= []
    nuxt.options.nitro.plugins.push(".nuxt/generated/plugin.ts")
    nuxt.hook("nitro:config", (config) => { config.plugins.push("./generated/plugin.ts") })
    nuxt.hook("nitro:init", (nitro) => { nitro.options.handlers.push({ handler: ".nuxt/generated/route.ts", route: "/api/x" }) })
    nuxt.hook("nitro:init", (nitro) => { nitro.options.plugins = [".nuxt/generated/assigned.ts"] })
  },
})`,
    }),
  ).toEqual([
    "modules/generated.ts:5",
    "modules/generated.ts:6",
    "modules/generated.ts:7",
    "modules/generated.ts:8",
    "src/vite.ts:9",
    "src/vite.ts:10",
    "src/vite.ts:15",
    "src/vite.ts:16",
  ]);
});

test("accepts absolute, aliased and computed paths", async () => {
  expect(
    await lines({
      "packages/agent/src/vite.ts": `import { join, resolve } from "pathe"
import type { Plugin } from "vite"
const generatedWebhook = ".vitehub/agent/webhook.ts"
export function handlers(root: string, generatedRoot: string) {
  return [
    { handler: join(root, generatedWebhook), route: "/hooks" },
    { handler: resolve(generatedRoot, "agent/ready.ts"), route: "/ready" },
    { handler: "~/server/handlers/ready.ts", route: "/ready" },
    { handler: "#vitehub/agent/route", route: "/agent" },
    { handler: "my-package/handler", route: "/pkg" },
    { handler: \`\${generatedRoot}/agent.ts\`, route: "/agent" },
    { handler: "./runtime/handler.ts" },
  ]
}`,
    }),
  ).toEqual([]);
});

test("leaves config files, tests, app code and files without integration imports alone", async () => {
  const registration = `export const nitro = { handlers: [{ handler: "./server/handler.ts", route: "/x" }], plugins: [] }`;
  expect(
    await lines({
      "nuxt.config.ts": `export default defineNuxtConfig({ nitro: { handlers: [{ handler: "./server/x.ts", route: "/x" }] } })`,
      "packages/blob/test/vite.test.ts": `import type { Plugin } from "vite"\n${registration}`,
      "server/plugins/register.ts": `import type { NitroApp } from "nitropack"\n${registration}`,
      "app/composables/useHandlers.ts": `import type { Plugin } from "vite"\n${registration}`,
      "scripts/nitro-options.ts": registration,
    }),
  ).toEqual([]);
});

test("leaves @nuxt/kit helper arguments to nuxt/module/resolve-runtime-paths", async () => {
  expect(
    await lines({
      "modules/server.ts": `import { addServerHandler, addServerPlugin, defineNuxtModule } from "@nuxt/kit"
export default defineNuxtModule({
  setup() {
    addServerHandler({ handler: "./runtime/server/handler", route: "/api/x" })
    addServerPlugin("./runtime/server/plugin")
  },
})`,
    }),
  ).toEqual([]);
});
