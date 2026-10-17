import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { defineDoctorExtension, defineRulePack, runDoctor } from "../../../src/core/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { requireStandardAuthHandlerMount } from "../../../src/rule-packs/nuxt/rules/nuxt-better-auth.ts";
import { withFixture, writeFileManifest } from "./nuxt-modern-rules-fixture.ts";

const extensions = [
  defineDoctorExtension({
    name: "better-auth-fixture",
    rulePacks: [
      defineRulePack({
        name: "better-auth-fixture",
        version: "0.0.0",
        rules: [requireStandardAuthHandlerMount],
        presets: { recommended: [requireStandardAuthHandlerMount.meta.id] },
      }),
    ],
  }),
];

test("accepts the auth handler a Nuxt module registers in the manifest", async () => {
  await withFixture(
    { "app/app.config.ts": "export default defineAppConfig({})" },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        serverHandlers: [
          {
            route: "/api/auth/**",
            file: "node_modules/@nuxtjs/better-auth/dist/runtime/server/api/auth/[...all]",
          },
        ],
      });
      const result = await runDoctor({ root, framework: "nuxt", extensions });
      expect(result.diagnostics).toEqual([]);
    },
  );
});

test("accepts the auth handler registered by @nuxtjs/better-auth without a manifest", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    dependencies: { "@nuxtjs/better-auth": "^0.3.4", "better-auth": "^1.3.0" },
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["@nuxtjs/better-auth"] })\n`,
      "app/app.config.ts": "export default defineAppConfig({})",
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("reports a missing handler at the Better Auth server instance", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "app/app.config.ts": "export default defineAppConfig({})",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'\n\nexport const auth = betterAuth({})\n",
    },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.file).toMatch(/server\/utils\/auth\.ts$/);
  expect(result.diagnostics[0]?.range).toMatchObject({ line: 3, column: 21 });
});

test("reports a missing handler at nuxt.config when no server instance is found", async () => {
  await withFixture(
    {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "app/app.config.ts": "export default defineAppConfig({})",
    },
    {},
    async (root) => {
      const result = await runDoctor({ root, framework: "nuxt", extensions });
      expect(result.diagnostics.map((item) => item.file)).toEqual([join(root, "nuxt.config.ts")]);
    },
  );
});
