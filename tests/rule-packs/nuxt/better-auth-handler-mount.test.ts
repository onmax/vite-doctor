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
    {
      "app/app.config.ts": "export default defineAppConfig({})",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'\n\nexport const auth = betterAuth({})\n",
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        generatedAt: new Date(Date.now() + 3_600_000).toISOString(),
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
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'\n\nexport const auth = betterAuth({})\n",
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

test("does not report a project with no Better Auth server instance", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    dependencies: { "better-auth": "^1.3.0", "nuxt-better-auth": "^0.6.0" },
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "app/app.config.ts": "export default defineAppConfig({})",
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("accepts the handler nuxt-better-auth mounts through its Nitro module", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    dependencies: { "better-auth": "^1.3.0", "nuxt-better-auth": "^0.6.0" },
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["nuxt-better-auth"] })\n`,
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'\n\nexport const auth = betterAuth({})\n",
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("reports when a handler module is installed but not registered", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    dependencies: { "@nuxtjs/better-auth": "^0.3.4", "better-auth": "^1.3.0" },
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "lib/auth.ts":
        "import { betterAuth } from 'better-auth'\n\nexport const auth = betterAuth({})\n",
    },
  });
  expect(result.diagnostics.map((item) => item.file)).toEqual([
    expect.stringMatching(/lib\/auth\.ts$/),
  ]);
});

const authInstance = {
  "nuxt.config.ts": "export default defineNuxtConfig({})\n",
  "server/utils/auth.ts":
    "import { betterAuth } from 'better-auth'\n\nexport const auth = betterAuth({})\n",
};
const future = new Date(Date.now() + 3_600_000).toISOString();

test("accepts a catch-all auth route Nitro resolved from a current manifest", async () => {
  await withFixture(authInstance, {}, async (root) => {
    await writeFileManifest(root, [], {
      generatedAt: future,
      resolvedServerHandlers: [
        { route: "/api/auth/**:all", file: "server/routes/api/auth/[...all].ts" },
      ],
    });
    const result = await runDoctor({ root, framework: "nuxt", extensions });
    expect(result.diagnostics).toEqual([]);
  });
});

test("ignores auth handlers recorded by a stale manifest", async () => {
  await withFixture(authInstance, {}, async (root) => {
    await writeFileManifest(root, [], {
      serverHandlers: [{ route: "/api/auth/**", file: "server/legacy/auth.ts" }],
    });
    const result = await runDoctor({ root, framework: "nuxt", extensions });
    expect(result.diagnostics.map((item) => item.file)).toEqual([
      join(root, "server/utils/auth.ts"),
    ]);
  });
});

test.each([
  [
    "a comment",
    `// modules: ["@nuxtjs/better-auth"]\nexport default defineNuxtConfig({ modules: [] })\n`,
  ],
  [
    "a string outside modules",
    `export default defineNuxtConfig({ modules: [], app: { head: { title: "nuxt-better-auth" } } })\n`,
  ],
])("reports when a handler module is only named in %s", async (_name, config) => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    dependencies: { "@nuxtjs/better-auth": "^0.3.4", "better-auth": "^1.3.0" },
    files: { ...authInstance, "nuxt.config.ts": config },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test("accepts a handler module registered with options", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      ...authInstance,
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: [["nuxt-better-auth", {}]] })\n`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("follows an aliased betterAuth import", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "server/utils/auth.ts":
        "import { betterAuth as createAuth } from 'better-auth'\n\nexport const auth = createAuth({})\n",
    },
  });
  expect(result.diagnostics[0]?.range).toMatchObject({ line: 3, column: 21 });
});

test("ignores a local function named betterAuth", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "server/utils/auth.ts": "function betterAuth() {}\n\nexport const auth = betterAuth()\n",
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("ignores a shadowed imported betterAuth binding", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'\n\nfunction f(betterAuth: () => void) { betterAuth() }\n",
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["block", "{ const betterAuth = () => {}; betterAuth() }"],
  ["catch", "try {} catch (betterAuth) { betterAuth() }"],
  ["named function expression", "const run = function betterAuth() { betterAuth() }\nrun()"],
  ["for loop", "for (const betterAuth of [() => {}]) betterAuth()"],
  ["for-in loop", "for (const betterAuth in {}) betterAuth()"],
  ["for-of loop", "for (const betterAuth of []) betterAuth()"],
  ["for initializer", "for (const betterAuth = betterAuth();; ) {}"],
  ["for test", "for (let betterAuth;;) { if (betterAuth()) break }"],
  ["for update", "for (let betterAuth;; betterAuth()) {}"],
  ["for-in RHS", "for (let betterAuth in betterAuth()) {}"],
  ["for-of RHS", "for (let betterAuth of betterAuth()) {}"],
])("ignores a %s-scoped shadow", async (_name, body) => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "server/utils/auth.ts": `import { betterAuth } from 'better-auth'\n${body}\n`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("reads modules when an unrelated config property is dynamic", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      ...authInstance,
      "nuxt.config.ts":
        "const key = 'title'\nexport default defineNuxtConfig({ [key]: 'x', modules: ['nuxt-better-auth'] })\n",
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["an imported module", "betterAuthModule"],
  ["an imported module with options", "[betterAuthModule, {}]"],
])("accepts a handler module registered as %s", async (_name, entry) => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      ...authInstance,
      "nuxt.config.ts": `import betterAuthModule from "nuxt-better-auth"\nexport default defineNuxtConfig({ modules: [${entry}] })\n`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("ignores a better-auth import that is commented out", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "server/utils/auth.ts":
        "/* import { betterAuth } from 'better-auth' */\nfunction betterAuth() {}\n\nexport const auth = betterAuth()\n",
    },
  });
  expect(result.diagnostics).toEqual([]);
});
