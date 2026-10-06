import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
  runDoctor,
} from "../../../src/core/index.ts";
import {
  noBrowserGlobalInUniversalCode,
  noRouteMiddlewareApiSecurity,
} from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import nuxtDoctorModule, { writeManifest } from "../../../src/rule-packs/nuxt/module.ts";
import { createRulesReport, createTextReport, explainRule } from "../../../src/core/index.ts";
import { nuxtDoctorExtensions, nuxtRulePacks } from "../../../src/rule-packs/nuxt/rules/index.ts";
import { createNuxtRuntimeEvidence } from "../../../src/rule-packs/nuxt/rules/nuxt/evidence.ts";
import { main } from "../../../src/cli.ts";
import { withFixture, writeFileManifest } from "./nuxt-modern-rules-fixture.ts";

test("Nuxt module writes evidence fields and text report shows evidence summary", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<template><div /></template>`,
      "server/api/user.ts": `export default defineEventHandler(() => ({ ok: true }))`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        pages: [{ path: "/", file: join(root, "app/pages/index.vue"), name: "index" }],
        prerenderRoutes: ["/"],
        buildManifest: {
          hasBuildManifest: true,
          chunks: [{ file: "entry.mjs", src: "app/pages/index.vue", isEntry: true }],
        },
        serverHandlers: [{ route: "/api/user", file: "server/api/user.ts", method: "GET" }],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [] })],
      });
      const report = createTextReport(result);

      expect(result.project.nuxt?.manifest?.evidence).toEqual({
        routeGraph: true,
        buildManifest: true,
        prerenderRoutes: 1,
        serverRoutes: 1,
      });
      expect(report).toContain(
        "Evidence used: manifest present, route graph present, build manifest present, 1 prerender routes, 1 server routes",
      );
      expect(report).toContain("Confidence mix: 0 proven, 0 probable, 0 source-only");
    },
  );
});

test("Nuxt module writes manifest source hook contributions", async () => {
  await withFixture({}, {}, async (root) => {
    const moduleRoot = join(root, "node_modules/fixture-module/runtime");
    const nuxt = {
      options: { rootDir: root, buildDir: ".nuxt", modules: [] },
      async callHook(name: string, payload: any[]) {
        if (name !== "doctor:extendSources") return;
        payload.push({
          module: "fixture-module",
          root: moduleRoot,
          packageDir: resolve(moduleRoot, ".."),
          include: ["**/*.{vue,ts}"],
          runtimeDirs: [moduleRoot],
        });
      },
    };

    await writeManifest(nuxt);

    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.moduleSources).toEqual([
      {
        module: "fixture-module",
        root: moduleRoot,
        packageDir: resolve(moduleRoot, ".."),
        include: ["**/*.{vue,ts}"],
        runtimeDirs: [moduleRoot],
      },
    ]);
  });
});

test("Nuxt runtime evidence classifies setup, client, server, lifecycle, command, and unknown execution", async () => {
  const evidenceRule = createRule({
    meta: {
      id: "test/nuxt-runtime-evidence",
      title: "Nuxt runtime evidence",
      category: "architecture",
      severity: "info",
      requires: { script: true, nuxt: true },
    },
    create(ctx) {
      const evidence = createNuxtRuntimeEvidence(ctx);
      return {
        CallExpression(node: any) {
          if (!ctx.helpers.isCall(node, "mark")) return;
          ctx.report(
            allDiagnostics.DOC9999({
              why: evidence.executionFor(node),
              fix: "Inspect the Nuxt runtime evidence.",
            }),
            {
              ruleId: "test/nuxt-runtime-evidence",
              severity: "info",
              category: "architecture",
              file: ctx.file.path,
              range: ctx.range(node),
            },
          );
        },
      };
    },
  });

  const result = await runRuleFixture({
    rule: evidenceRule,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
mark('setup')
function handleClick() { mark('event') }
onMounted(() => mark('lifecycle'))
const commands = { open() { mark('command') } }
function helper() { mark('unknown') }
</script>
<template><button @click="handleClick">Open</button></template>`,
      "server/api/user.ts": `export default defineEventHandler(() => mark('server'))`,
      "app/plugins/client.client.ts": `mark('client')`,
      "app/utils/evidence.ts": `function helper() { mark('unknown') }`,
    },
  });

  expect(result.diagnostics.map((item) => item.message).sort()).toEqual([
    "client-only",
    "client-only",
    "event-handler",
    "returned-command",
    "server-only",
    "setup-time",
    "unknown",
  ]);
});

test("Nuxt Doctor rule payloads use JSON report helpers", () => {
  const rules = JSON.parse(createRulesReport(nuxtRulePacks(), "json"));
  expect(rules.rules.map((rule: any) => rule.pack)).toEqual(
    expect.arrayContaining([
      "vite-doctor/nitro",
      "vite-doctor/nuxt",
      "vite-doctor/nuxt-content",
      "vite-doctor/nuxt-ui",
      "vite-doctor/nuxt-scripts",
      "vite-doctor/vueuse",
      "vite-doctor/nuxt-image",
      "vite-doctor/nuxthub",
      "vite-doctor/nuxt-better-auth",
      "vite-doctor/docus",
    ]),
  );

  const explanation = JSON.parse(
    explainRule(nuxtRulePacks(), "nuxt/fetch/no-raw-fetch-in-setup", "json"),
  );
  expect(explanation.id).toBe("nuxt/fetch/no-raw-fetch-in-setup");
  expect(explainRule(nuxtRulePacks(), "nuxt/does-not-exist", "json")).toBe("");
});

test("explicit Nuxt module sources are scanned with module metadata", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup>const ok = true</script>`,
      "node_modules/unscanned-module/runtime/Bad.vue": `<script setup>const width = window.innerWidth</script>`,
      "node_modules/fixture-module/runtime/Bad.vue": `<script setup>const width = window.innerWidth</script>`,
      "node_modules/fixture-module/runtime/useBad.ts": `export function useBad() { return window.innerWidth }`,
    },
    {},
    async (root) => {
      const moduleRoot = join(root, "node_modules/fixture-module/runtime");
      const moduleRule = createRule({
        meta: {
          id: "fixture/module-source",
          title: "Module source",
          category: "architecture",
          severity: "error",
          requires: { script: true, nuxt: true },
        },
        create(ctx) {
          return {
            Program() {
              if (!ctx.file.isModuleSource()) return;
              ctx.report(
                allDiagnostics.DOC9999({
                  why: `${ctx.file.moduleName}:${ctx.file.relativePath}`,
                  fix: "Inspect the module source fixture.",
                }),
                {
                  ruleId: "fixture/module-source",
                  severity: "error",
                  category: "architecture",
                  file: ctx.file.path,
                },
              );
            },
          };
        },
      });

      await writeFileManifest(root, [
        {
          module: "fixture-module",
          root: moduleRoot,
          packageDir: join(root, "node_modules/fixture-module"),
          include: ["**/*.{vue,ts}"],
        },
      ]);

      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [moduleRule],
                presets: { recommended: ["fixture/module-source"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics.map((item) => item.message).sort()).toEqual([
        "fixture-module:fixture-module:Bad.vue",
        "fixture-module:fixture-module:useBad.ts",
      ]);
      expect(result.diagnostics.some((item) => item.file.includes("unscanned-module"))).toBe(false);
    },
  );
});

test("default Nuxt scans do not traverse node_modules source", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup>const ok = true</script>`,
      "node_modules/unscanned-module/runtime/Bad.vue": `<script setup>const width = window.innerWidth</script>`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noBrowserGlobalInUniversalCode],
                presets: {
                  recommended: ["nuxt/hydration/no-browser-global-in-universal-code"],
                },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("built-in Nuxt app rule packs skip explicit module sources", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup>const ok = true</script>`,
      "node_modules/fixture-module/runtime/Bad.vue": `<script setup>const width = window.innerWidth</script>`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [
        {
          module: "fixture-module",
          root: join(root, "node_modules/fixture-module/runtime"),
          include: ["**/*.{vue,ts}"],
        },
      ]);

      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: {
          nuxt: "4.0.0",
          nitro: "2.0.0",
          h3: "1.0.0",
          vue: "3.5.0",
          nuxtCompatibility: 4,
        },
        extensions: nuxtDoctorExtensions(),
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("vite-doctor exits 1 for Nuxt errors and 0 for warnings unless max warnings is zero", async () => {
  await withFixture(
    {
      "app/pages/error.vue": `<script setup>const width = window.innerWidth</script>`,
      "app/pages/warn.vue": `<script setup>const theme = localStorage.getItem('theme')</script>`,
    },
    {},
    async (root) => {
      expect(
        await main([root, "--rules", "nuxt/hydration/no-browser-global-in-universal-code"]),
      ).toBe(1);
      expect(
        await main([root, "--rules", "nuxt/hydration/prefer-usecookie-for-initial-client-state"]),
      ).toBe(0);
      expect(
        await main([
          root,
          "--rules",
          "nuxt/hydration/prefer-usecookie-for-initial-client-state",
          "--max-warnings",
          "0",
        ]),
      ).toBe(1);
    },
  );
}, 30000);

test("vite-doctor stores Nuxt cache inside the Nuxt build directory", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup>const width = window.innerWidth</script>`,
    },
    {},
    async (root) => {
      await main([root, "--rules", "nuxt/hydration/no-browser-global-in-universal-code"]);

      expect(existsSync(join(root, ".nuxt/doctor/cache"))).toBe(true);
      expect(existsSync(join(root, ".vite-doctor"))).toBe(false);
      expect(existsSync(join(root, ".vue-doctor"))).toBe(false);
    },
  );
}, 30000);

test.each([true, false])(
  "Nuxt manifest preserves layer alias directories and setting: %s",
  async (localLayerAliases) => {
    await withFixture({}, {}, async (root) => {
      const layerRoot = join(root, "layers/admin");
      await writeManifest({
        options: {
          rootDir: root,
          buildDir: ".nuxt",
          modules: [],
          experimental: { localLayerAliases },
          _layers: [
            {
              cwd: layerRoot,
              config: {
                rootDir: layerRoot,
                srcDir: join(layerRoot, "src"),
                dir: { middleware: "guards" },
                serverDir: join(layerRoot, "backend"),
              },
            },
          ],
        },
        async callHook() {},
      });
      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.localLayerAliases).toBe(localLayerAliases);
      expect(manifest.layers[0]).toMatchObject({
        root: layerRoot,
        srcDir: join(layerRoot, "src"),
        appMiddlewareDir: join(layerRoot, "src/guards"),
        serverDir: join(layerRoot, "backend"),
      });
    });
  },
);

test.each([undefined, "2000-01-01T00:00:00.000Z"])(
  "ignores stale registered handlers with timestamp %s",
  async (generatedAt) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": "export default defineNuxtConfig({})",
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/handlers/data.ts": "export default defineEventHandler(() => ({}))",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt,
          serverHandlers: [{ file: "server/handlers/data.ts", route: "/api/account" }],
        }),
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

test("session lookup alone does not protect a sensitive handler", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts":
        "export default defineEventHandler(async event => { const session = await getUserSession(event); return { private: true } })",
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  "import { requireAuth } from './auth'; export default defineEventHandler(() => ({ private: true }))",
  "export default defineEventHandler(() => { /* requireAuth(event) */ return { private: true } })",
  "export default defineEventHandler(event => { const unused = () => requireAuth(event); return { private: true } })",
  "export default defineEventHandler(() => ({ note: 'requireAuth(event)' }))",
])("unused guard references do not protect a sensitive handler: %s", async (handler) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": handler,
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  "",
  "import { toWebRequest } from 'h3';",
  "import { toWebRequest } from '#imports';",
  "import { toWebRequest as toRequest } from 'h3';",
  "function unrelated() { var toWebRequest = () => new Request('https://example.com') }",
  "if (true) { const toWebRequest = () => new Request('https://example.com') }",
])(
  "standard auth provider catch-all delegates authorization to the provider: %s",
  async (converter) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/auth/[...all].ts": `${converter} import { auth } from '../../utils/auth'; export default defineEventHandler(event => auth.handler(${converter.includes("as toRequest") ? "toRequest" : "toWebRequest"}(event)))`,
        "server/utils/auth.ts":
          "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

test("provider catch-all permits setup before terminal delegation", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { setHeader(event, 'x-auth', 'yes'); return auth.handler(toWebRequest(event)) })",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("provider catch-all accepts the H3 eventHandler wrapper", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { eventHandler } from 'h3'; import { auth } from '../../utils/auth'; export default eventHandler(event => auth.handler(toWebRequest(event)))",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("provider catch-all accepts Nuxt's auto-imported eventHandler wrapper", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '../../utils/auth'; export default eventHandler(event => auth.handler(toWebRequest(event)))",
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  "function eventHandler(callback) { return callback };",
  "import { eventHandler } from './unrelated';",
  "if (true) { var eventHandler = callback => callback }",
  "for (var eventHandler of []) {}",
  "try { var eventHandler = callback => callback } catch {}",
])("provider catch-all does not trust an unrelated eventHandler binding: %s", async (binding) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts": `${binding} import { auth } from '../../utils/auth'; export default eventHandler(event => auth.handler(toWebRequest(event)))`,
      "server/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test.each([
  ...[
    "if (true) { var toWebRequest = () => new Request('https://example.com') }",
    "for (var toWebRequest of []) {}",
    "try { var toWebRequest = () => new Request('https://example.com') } catch {}",
  ].map(
    (declaration) =>
      `import { auth } from '../../utils/auth'; ${declaration}; export default defineEventHandler(event => auth.handler(toWebRequest(event)))`,
  ),
  "import { auth } from '../../utils/auth'; export default defineEventHandler(function toWebRequest(event) { return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { const toWebRequest = customConverter; return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { const { toWebRequest } = customConverters; return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; import { toWebRequest as toRequest } from 'h3'; export default defineEventHandler(event => { const toRequest = customConverter; return auth.handler(toRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler((event, toWebRequest) => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; const toWebRequest = () => new Request('https://example.com'); export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; import { toWebRequest } from './unrelated'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; function toWebRequest() { return new Request('https://example.com') }; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(toWebRequest => auth.handler(toWebRequest(toWebRequest)))",
  "const auth = { handler: () => ({ private: true }) }; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from './unrelated'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => auth.handler())",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(other)))",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(auth => auth.handler(toWebRequest(auth)))",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { const auth = { handler() {} }; return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(event => { const { auth } = { auth: { handler() {} } }; return auth.handler(toWebRequest(event)) })",
  "import { auth } from '../../utils/auth'; export default defineEventHandler(function auth(event) { return auth.handler(toWebRequest(event)) })",
])(
  "provider-shaped calls without provenance or request delegation remain sensitive: %s",
  async (handler) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/auth/[...all].ts": handler,
        "server/api/auth/unrelated.ts":
          "export const auth = { handler: () => ({ private: true }) }",
        "server/utils/auth.ts":
          "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
      },
    });
    expect(
      result.diagnostics.some((item) => item.file.endsWith("server/api/auth/[...all].ts")),
    ).toBe(true);
  },
);

test.each(["~/utils/auth", "@/utils/auth", "~~/app/utils/auth", "@@/app/utils/auth"])(
  "auth providers resolve Nuxt alias %s",
  async (source) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/auth/[...all].ts": `import { auth } from '${source}'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))`,
        "app/utils/auth.ts":
          "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each([true, false])("aliased auth providers require provenance: %s", async (supported) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "custom/utils/auth.ts": supported
        ? "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})"
        : "export const auth = { handler: () => ({ private: true }) }",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        nuxtVersion: "4",
        vueVersion: "3.5",
        appDir: "app",
        aliases: { "~": "custom" },
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(supported ? 0 : 1);
});

test.each([
  ["auth/register.post.ts", "delete", 1],
  ["auth/register.ts", "post", 0],
  ["auth/register.get.ts", "post", 0],
  ["auth/register.post.ts", undefined, 1],
])("registered auth handler %s uses registration method %s", async (file, method, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      [`server/handlers/${file}`]: `export default defineEventHandler(() => ({}))`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        appDir: "app",
        serverHandlers: [{ file: `server/handlers/${file}`, route: "/api/auth/register", method }],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  [
    "const handler = defineEventHandler(async event => { await requireAuth(event) }); export default handler",
    0,
  ],
  [
    "const handler = eventHandler(event => requireAuth(event)); const alias = handler; export default alias",
    0,
  ],
  ["const handler = defineEventHandler(() => ({})); export default handler", 1],
  ["const handler = alias; const alias = handler; export default handler", 1],
  [
    "let handler = defineEventHandler(event => requireAuth(event)); handler = defineEventHandler(() => ({})); export default handler",
    1,
  ],
])("exported handler bindings preserve guard coverage: %s", async (source, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/api/account.get.ts": source,
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["import { betterAuth } from 'better-auth'; export default betterAuth({})", 0],
  ["import { betterAuth as createAuth } from 'better-auth'; export default createAuth({})", 0],
  [
    "import { betterAuth } from 'better-auth'; const instance = betterAuth({}); export default instance",
    0,
  ],
  ["const betterAuth = () => ({}); export default betterAuth({})", 1],
  ["export default { handler: request => request }", 1],
])("default provider imports require Better Auth provenance: %s", async (provider, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import auth from '#auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "app/utils/auth.ts": provider,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        aliases: { "#auth": "app/utils/auth.ts" },
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each(["ts", "js", "mts", "mjs", "cts", "cjs"])(
  "auth providers resolve directory index.%s with provenance",
  async (extension) => {
    for (const supported of [true, false]) {
      const result = await runRuleFixture({
        rule: noRouteMiddlewareApiSecurity,
        framework: "nuxt",
        files: {
          "app/middleware/auth.ts":
            "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
          "server/api/auth/[...all].ts":
            "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
          [`app/utils/auth/index.${extension}`]: supported
            ? "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})"
            : "export const auth = { handler: () => ({ private: true }) }",
        },
      });
      expect(result.diagnostics).toHaveLength(supported ? 0 : 1);
    }
  },
);

test.each([
  ["const auth = betterAuth({}); export { auth }", 0],
  ["const instance = betterAuth({}); export { instance as auth }", 0],
  ["const auth = { handler: () => ({}) }; export { auth }", 1],
  ["const auth = betterAuth({}); export { auth } from './other'", 1],
  ["const auth = betterAuth({}); export type { auth }", 1],
])("provider export lists require local provenance: %s", async (provider, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "app/utils/auth.ts": `import { betterAuth } from 'better-auth'; ${provider}`,
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["export { auth } from './server'", "export const auth = betterAuth({})", 0],
  ["export * from './server'", "export const auth = betterAuth({})", 0],
  ["export * from './server'", "export const auth = { handler: () => ({}) }", 1],
  ["export * from './server'", "const auth = betterAuth({})", 1],
  ["export { instance as auth } from './server'", "export const instance = betterAuth({})", 0],
  ["export { auth } from './server'", "export const auth = { handler: () => ({}) }", 1],
  ["export { auth } from './server'", "const auth = betterAuth({})", 1],
  ["import { auth } from './server'; export { auth }", "export const auth = betterAuth({})", 0],
  [
    "import { instance as auth } from './server'; export { auth }",
    "export const instance = betterAuth({})",
    0,
  ],
  [
    "import { auth } from './server'; export { auth }",
    "export const auth = { handler: () => ({}) }",
    1,
  ],
  ["export { auth } from './auth'", "export { auth } from './index'", 1],
])("provider re-exports require exported provenance: %s", async (barrel, provider, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/auth/[...all].ts":
        "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "app/utils/auth/index.ts": barrel,
      "app/utils/auth/server.ts": `import { betterAuth } from 'better-auth'; ${provider}`,
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test("Nuxt module captures and refreshes Nitro's resolved handlers", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    const nitroHooks = new Map<string, () => unknown>();
    const nuxt = {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    };
    await nuxtDoctorModule({}, nuxt as any);
    const nitro = {
      options: {
        dev: false,
        preset: "node-server",
        handlers: [{ handler: join(root, "custom/account.ts"), route: "/api/account" }],
      },
      scannedHandlers: [
        {
          handler: join(root, "layer/profile.ts"),
          route: "/api/profile",
          method: "get",
          env: "prod",
        },
        { handler: join(root, "layer/debug.ts"), route: "/api/admin", env: "dev" },
        { handler: join(root, "layer/guard.ts"), middleware: true, env: ["prod", "prerender"] },
      ],
      hooks: { hook: (name: string, callback: () => unknown) => nitroHooks.set(name, callback) },
    };
    await hooks.get("nitro:init")!(nitro);
    const readHandlers = () =>
      JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"))
        .resolvedServerHandlers;
    expect(readHandlers()).toEqual([
      { file: "layer/profile.ts", route: "/api/profile", method: "get" },
      { file: "layer/guard.ts", middleware: true },
      { file: "custom/account.ts", route: "/api/account" },
    ]);
    nitro.scannedHandlers = [];
    await nitroHooks.get("compiled")!();
    await hooks.get("prepare:types")!();
    expect(readHandlers()).toEqual([{ file: "custom/account.ts", route: "/api/account" }]);
    nitro.options.handlers = [];
    await nitroHooks.get("rollup:before")!();
    expect(readHandlers()).toEqual([]);
  });
});

test.each([
  "unguarded",
  "guarded",
  "scoped-guard",
  "matching-scope",
  "method-guard",
  "matching-method",
  "empty",
])("NUXT0037 uses resolved layer handlers and middleware: %s", async (state) => {
  const handler = "layers/admin/backend/api/account.ts";
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      [handler]: "export default defineEventHandler(() => ({ private: true }))",
      "layers/admin/backend/api/health.ts": "export default defineEventHandler(() => 'ok')",
      "layers/admin/backend/middleware/auth.ts":
        "export default defineEventHandler(event => requireUserSession(event))",
      "server/api/profile.ts": "export default defineEventHandler(() => ({ ignored: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [{ root: "layers/admin", serverDir: "layers/admin/backend", priority: 0 }],
        resolvedServerHandlers:
          state === "empty"
            ? []
            : [
                {
                  file: handler,
                  route: "/api/account",
                  method: state === "matching-method" ? "get" : undefined,
                },
                { file: "layers/admin/backend/api/health.ts", route: "/api/health" },
                ...(state === "unguarded"
                  ? []
                  : [
                      {
                        file: "layers/admin/backend/middleware/auth.ts",
                        middleware: true,
                        route:
                          state === "scoped-guard"
                            ? "/api/admin/**"
                            : state === "matching-scope"
                              ? "/api/**"
                              : undefined,
                        method:
                          state === "method-guard"
                            ? "post"
                            : state === "matching-method"
                              ? "get"
                              : undefined,
                      },
                    ]),
              ],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(
    ["guarded", "matching-scope", "matching-method", "empty"].includes(state) ? 0 : 1,
  );
  if (result.diagnostics.length)
    expect(result.diagnostics[0]!.related?.map((item) => item.file)).toEqual([
      expect.stringContaining(handler),
    ]);
});

test("NUXT0037 finds auto-registered layer middleware with a stale manifest", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({})",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      "layers/old/app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2000-01-01T00:00:00.000Z",
        appDir: "layers/old/app",
        layers: [
          {
            root: "layers/old",
            srcDir: "layers/old/app",
            appMiddlewareDir: "layers/old/app/middleware",
            priority: 0,
          },
        ],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 keeps configured middleware when only server inventory is stale", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "src/guards/auth.ts": "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        appDir: "src",
        layers: [{ root: ".", srcDir: "src", appMiddlewareDir: "src/guards", priority: 0 }],
        serverInventory: { server: [] },
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 discovers configured source and middleware directories without a manifest", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts":
        "export default defineNuxtConfig({ srcDir: 'src', dir: { middleware: 'guards' } })",
      "src/guards/auth.ts": "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 discovers auto-registered layer handlers without a manifest", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "layers/admin/server/api/account.get.ts":
        "export default defineEventHandler(() => ({ private: true }))",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 uses root middleware when a layer app directory has no effective contents", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "layers/admin/app/router.options.ts": "export default {}",
      "layers/admin/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "layers/admin/server/api/account.get.ts":
        "export default defineEventHandler(() => ({ private: true }))",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test("NUXT0037 ignores unrelated middleware options without a manifest", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts":
        "export default defineNuxtConfig({ nitro: { handlers: [{ handler: './guard', middleware: true }] } })",
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test.each([
  "const source = 'src'; export default defineNuxtConfig({ srcDir: source })",
  "export default defineNuxtConfig({ serverDir: 'backend' })",
])(
  "NUXT0037 records an evidence gap for unresolved config without a manifest: %s",
  async (config) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": config,
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      },
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(
      0,
    );
    expect(
      result.project.evidenceGaps?.some(
        (gap) => gap.source === "vite-doctor/nuxt-middleware-api-security",
      ),
    ).toBe(true);
  },
);

test.each([
  ["identifier keys", "srcDir: 'src'", "middleware"],
  ["quoted keys", '"srcDir": "src", dir: { "middleware": "guards" }', "guards"],
])(
  "NUXT0037 finds the current root source directory after config changes with %s",
  async (_label, config, middlewareDir) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": `export default defineNuxtConfig({ ${config} })`,
        [`src/${middlewareDir}/auth.ts`]:
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: "2000-01-01T00:00:00.000Z",
          appDir: "layers/old/app",
          layers: [{ root: "layers/old", srcDir: "layers/old/app", priority: 0 }],
        }),
      },
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(
      1,
    );
  },
);

test("NUXT0037 ignores stale registered handlers when server inventory changes", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/handlers/account.ts": "export default defineEventHandler(() => ({ private: true }))",
      "server/api/health.ts": "export default defineEventHandler(() => 'ok')",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        serverInventory: { server: [] },
        serverHandlers: [{ file: "server/handlers/account.ts", route: "/api/account" }],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(0);
});

test("NUXT0037 finds new layer handlers when resolved server inventory is stale", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "layers/admin/backend/api/account.get.ts":
        "export default defineEventHandler(() => ({ private: true }))",
      "layers/admin/backend/api/health.get.ts":
        "export default defineEventHandler(() => ({ public: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [{ root: "layers/admin", serverDir: "layers/admin/backend", priority: 0 }],
        serverInventory: { "layers/admin/backend": [] },
        resolvedServerHandlers: [],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
  expect(result.diagnostics[0]?.file).toContain("account.get.ts");
});

test("NUXT0037 finds new root handlers under a configured serverDir", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "backend/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [{ root: ".", serverDir: "backend", priority: 0 }],
        serverInventory: { backend: [] },
        resolvedServerHandlers: [],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
  expect(result.diagnostics[0]?.file).toContain("account.get.ts");
});

test.each(["login.post.ts", "sign-in.post.ts", "signin.post.ts", "callback.get.ts"])(
  "NUXT0037 ignores public layer endpoint %s when resolved server inventory is stale",
  async (endpoint) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        [`layers/admin/backend/api/auth/${endpoint}`]:
          "export default defineEventHandler(() => ({ public: true }))",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: "2100-01-01T00:00:00.000Z",
          layers: [{ root: "layers/admin", serverDir: "layers/admin/backend", priority: 0 }],
          serverInventory: { "layers/admin/backend": [] },
          resolvedServerHandlers: [],
        }),
      },
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(
      0,
    );
  },
);

test("NUXT0037 records an evidence gap for nonliteral changed middleware configuration", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": "const source = 'src'; export default defineNuxtConfig({ srcDir: source })",
      "src/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts": "export default defineEventHandler(() => ({ private: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2000-01-01T00:00:00.000Z",
        appDir: "app",
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(0);
  expect(
    result.project.evidenceGaps?.some(
      (gap) => gap.source === "vite-doctor/nuxt-middleware-api-security",
    ),
  ).toBe(true);
});

test("NUXT0037 requires fresh evidence when changed config moves the server directory", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({ serverDir: 'backend' })",
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "backend/api/account.ts": "export default defineEventHandler(() => ({ private: true }))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2000-01-01T00:00:00.000Z",
        appDir: "app",
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(0);
  expect(
    result.project.evidenceGaps?.some(
      (gap) => gap.source === "vite-doctor/nuxt-middleware-api-security",
    ),
  ).toBe(true);
});

test("NUXT0037 does not treat differently cased methods as matching constraints", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.ts": "export default defineEventHandler(() => ({ private: true }))",
      "server/middleware/auth.ts":
        "export default defineEventHandler(event => requireUserSession(event))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        resolvedServerHandlers: [
          { file: "server/api/account.ts", route: "/api/account", method: "GET" },
          { file: "server/middleware/auth.ts", middleware: true, method: "get" },
        ],
      }),
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037")).toHaveLength(1);
});

test.each([true, false])("provider aliases follow localLayerAliases: %s", async (enabled) => {
  const handler = "layers/admin/server/api/auth/[...all].ts";
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      [handler]:
        "import { auth } from '~/utils/auth'; export default defineEventHandler(event => auth.handler(toWebRequest(event)))",
      "layers/admin/app/utils/auth.ts":
        "import { betterAuth } from 'better-auth'; export const auth = betterAuth({})",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        localLayerAliases: enabled,
        layers: [{ root: "layers/admin", srcDir: "layers/admin/app", priority: 0 }],
        resolvedServerHandlers: [{ file: handler, route: "/api/auth/**" }],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(enabled ? 0 : 1);
});

test("Nuxt captures cached wildcard overlaps and nested cache exclusions", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    const nuxt = {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    };
    await nuxtDoctorModule({}, nuxt as any);
    await hooks.get("nitro:init")!({
      options: {
        handlers: [{ handler: join(root, "custom/entry.ts"), route: "/api/**", method: "get" }],
        routeRules: {
          "/api/account": { cache: { maxAge: 60 } },
          "/api/admin/**": { cache: { maxAge: 60 } },
          "/api/admin/settings": { cache: false },
          "/api/profile": { cache: false },
          "/outside/account": { cache: { maxAge: 60 } },
        },
      },
      scannedHandlers: [],
      hooks: { hook() {} },
    });
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.resolvedServerHandlers.map((handler: any) => handler.route)).toEqual([
      "/api/account",
      "/api/admin/settings",
      "/api/admin/**",
      "/api/**",
    ]);
    expect(manifest.resolvedServerHandlers.every((handler: any) => handler.method === "get")).toBe(
      true,
    );
  });
});

test("Nuxt expands cached routes using the first registered wildcard handler", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    await nuxtDoctorModule({}, {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    } as any);
    await hooks.get("nitro:init")!({
      options: {
        handlers: [
          { handler: join(root, "custom/generic.ts"), route: "/api/**" },
          { handler: join(root, "custom/admin.ts"), route: "/api/admin/**" },
        ],
        routeRules: { "/api/admin/account": { cache: { maxAge: 60 } } },
      },
      scannedHandlers: [],
      hooks: { hook() {} },
    });
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(
      manifest.resolvedServerHandlers.find((handler: any) => handler.route === "/api/admin/account")
        ?.file,
    ).toBe("custom/generic.ts");
  });
});

test("Nuxt inventories registered handlers outside server directories", async () => {
  await withFixture(
    { "custom/account.ts": "export default defineEventHandler(() => ({}))" },
    {},
    async (root) => {
      const hooks = new Map<string, (payload?: any) => unknown>();
      await nuxtDoctorModule({}, {
        _version: "4.5.1",
        options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
        hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
        async callHook() {},
      } as any);
      const file = join(root, "custom/account.ts");
      await hooks.get("nitro:init")!({
        options: { handlers: [{ handler: file, route: "/api/account" }] },
        scannedHandlers: [],
        hooks: { hook() {} },
      });
      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.serverInventory[join(root, "custom")]).toEqual(["account.ts"]);
      expect(manifest.serverHandlerMtimes[file]).toEqual(expect.any(Number));
    },
  );
});

test("cached wildcard overlap respects route segment boundaries", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    const nuxt = {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    };
    await nuxtDoctorModule({}, nuxt as any);
    await hooks.get("nitro:init")!({
      options: {
        handlers: [{ handler: join(root, "custom/entry.ts"), route: "/api/ad/**" }],
        routeRules: { "/api/admin": { cache: { maxAge: 60 } } },
      },
      scannedHandlers: [],
      hooks: { hook() {} },
    });
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.resolvedServerHandlers.map((handler: any) => handler.route)).toEqual([
      "/api/ad/**",
    ]);
  });
});

test.each(["changed", "since"])(
  "NUXT0037 reports changed handlers with unchanged middleware: %s",
  async (mode) => {
    await withFixture(
      {
        "app/middleware/auth.ts":
          "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
        "server/api/account.get.ts": "export default defineEventHandler(() => ({ public: true }))",
      },
      {},
      async (root) => {
        const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
        git("init");
        git("add", ".");
        git(
          "-c",
          "user.name=Doctor",
          "-c",
          "user.email=doctor@example.com",
          "commit",
          "-m",
          "fixture",
        );
        writeFileSync(
          join(root, "server/api/account.get.ts"),
          "export default defineEventHandler(() => ({ private: true }))",
        );
        const result = await runDoctor({
          root,
          framework: "nuxt",
          ...(mode === "changed" ? { changed: true } : { since: "HEAD" }),
          extensions: [
            defineDoctorExtension({
              name: "nuxt-auth-scope",
              rulePacks: [
                defineRulePack({
                  name: "nuxt-auth-scope",
                  version: "1",
                  rules: [noRouteMiddlewareApiSecurity],
                  presets: { recommended: [noRouteMiddlewareApiSecurity.meta.id] },
                }),
              ],
            }),
          ],
        });
        expect(
          result.diagnostics.filter((diagnostic) => diagnostic.code === "NUXT0037"),
        ).toHaveLength(1);
        expect(result.diagnostics.find((diagnostic) => diagnostic.code === "NUXT0037")?.file).toBe(
          join(root, "server/api/account.get.ts"),
        );
      },
    );
  },
);
