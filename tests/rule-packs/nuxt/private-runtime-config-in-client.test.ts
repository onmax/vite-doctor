import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildNuxt, defineNuxtModule, loadNuxt } from "nuxt/kit";
import { dirname, join } from "pathe";
import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { noPrivateRuntimeConfigInClient } from "../../../src/rule-packs/nuxt/rules/nuxt/no-private-runtime-config-in-client.ts";

const manifest = JSON.stringify({
  generatedAt: new Date(Date.now() + 10_000).toISOString(),
  nuxtVersion: "4.5.2",
  appDir: "app",
  autoImportEnabled: true,
  autoImports: [
    { name: "useRuntimeConfig", from: "#app/nuxt", kind: "nuxt" },
    { name: "useRequestEvent", from: "#app/composables/ssr", kind: "nuxt" },
    { name: "onServerPrefetch", from: "vue", kind: "vue" },
  ],
  components: [],
  layers: [],
  runtimeConfig: {
    apiSecret: "<redacted>",
    stripe: { secretKey: "<redacted>" },
    app: { baseURL: "/" },
    public: { apiBase: "<redacted>" },
  },
});

async function run(files: Record<string, string>, withManifest = true) {
  return runProjectFixture({
    rules: [noPrivateRuntimeConfigInClient],
    framework: "nuxt",
    files: withManifest ? { ".nuxt/doctor.manifest.json": manifest, ...files } : files,
  });
}

const page = (script: string) =>
  `<script setup lang="ts">\n${script}\n</script>\n<template><div /></template>`;

describe("nuxt/runtime/no-private-runtime-config-in-client", () => {
  test("reports a private key read through a config variable in component setup", async () => {
    const { diagnostics } = await run({
      "app/pages/index.vue": page(
        "const config = useRuntimeConfig()\nconst headers = { Authorization: config.apiSecret }",
      ),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("NUXT0102");
    expect(diagnostics[0]?.severity).toBe("warn");
    expect(diagnostics[0]?.confidence).toBe("manifest-backed");
    expect(diagnostics[0]?.range?.line).toBe(3);
    expect(diagnostics[0]?.why).toContain("runtimeConfig.apiSecret");
    expect(diagnostics[0]?.why).toContain("NUXT_E1003");
    expect(diagnostics[0]?.suggestion).toContain("runtimeConfig.public");
  });

  test("reports reads in click handlers, client plugins and middleware", async () => {
    const { diagnostics } = await run({
      "app/components/Pay.vue": page(
        "function pay() {\n  return $fetch('/pay', { body: { key: useRuntimeConfig().stripe.secretKey } })\n}",
      ),
      "app/plugins/analytics.client.ts":
        "export default defineNuxtPlugin(() => {\n  const { apiSecret, public: pub } = useRuntimeConfig()\n  console.log(apiSecret, pub)\n})\n",
      "app/middleware/auth.ts":
        "import { useRuntimeConfig } from '#imports'\nexport default defineNuxtRouteMiddleware(() => {\n  if (!useRuntimeConfig()['apiSecret']) return abortNavigation()\n})\n",
    });

    expect(
      diagnostics.map((diagnostic) => [diagnostic.file.split("/app/")[1], diagnostic.range?.line]),
    ).toEqual(
      expect.arrayContaining([
        ["components/Pay.vue", 3],
        ["plugins/analytics.client.ts", 2],
        ["middleware/auth.ts", 3],
      ]),
    );
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]?.why).toContain("runtimeConfig.stripe");
  });

  test("stays quiet for public, app and undeclared keys", async () => {
    const { diagnostics } = await run({
      "app/pages/index.vue": page(
        "const config = useRuntimeConfig()\nconst a = config.public.apiBase\nconst b = config.app.baseURL\nconst c = config.unknownKey",
      ),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet for reads that only run on the server", async () => {
    const { diagnostics } = await run({
      "app/pages/a.vue": page(
        "const config = useRuntimeConfig()\nif (import.meta.server) console.log(config.apiSecret)\nconst token = process.server ? config.apiSecret : ''\nconst other = import.meta.client ? '' : config.apiSecret\nimport.meta.server && console.log(config.apiSecret)\nonServerPrefetch(() => console.log(config.apiSecret))",
      ),
      "app/pages/b.vue": page(
        "function load() {\n  if (import.meta.client) return\n  return useRuntimeConfig().apiSecret\n}",
      ),
      "app/pages/c.vue": page(
        "const event = useRequestEvent()\nif (event) console.log(useRuntimeConfig().apiSecret)",
      ),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet in server components, server plugins, server routes and composables", async () => {
    const { diagnostics } = await run({
      "app/components/Report.server.vue": page("const key = useRuntimeConfig().apiSecret"),
      "app/plugins/session.server.ts":
        "export default defineNuxtPlugin(() => { useRuntimeConfig().apiSecret })\n",
      "server/api/items.ts":
        "export default defineEventHandler((event) => useRuntimeConfig(event).apiSecret)\n",
      "app/composables/useApi.ts": "export const useApi = () => useRuntimeConfig().apiSecret\n",
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet in components/islands, which Nuxt renders only on the server", async () => {
    const { diagnostics } = await run({
      "app/components/islands/Invoice.vue": page("const key = useRuntimeConfig().apiSecret"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("reports a raw island import even when another page uses the Nuxt wrapper", async () => {
    const { diagnostics } = await run({
      "app/components/islands/Invoice.vue": page("const key = useRuntimeConfig().apiSecret"),
      "app/pages/wrapped.vue": "<template><Invoice /></template>",
      "app/pages/raw.vue": page("import Invoice from '../components/islands/Invoice.vue'").replace(
        "<div />",
        "<Invoice />",
      ),
    });
    expect(diagnostics.map(({ confidence }) => confidence)).toEqual(["heuristic-medium"]);
  });

  test("checks alias-only imports in branches that can run in the browser", async () => {
    const { diagnostics } = await run({
      "app/pages/index.vue": page(
        [
          "import { useRuntimeConfig as config } from '#app'",
          "if (import.meta.client && ready.value) {} else console.log(config().apiSecret)",
          "if (import.meta.server || preview.value) console.log(config().apiSecret)",
          "const event = true; if (event) console.log(config().apiSecret)",
          "function setup() { if (import.meta.client && ready.value) return; console.log(config().apiSecret) }",
          "if (!import.meta.client && ready.value) console.log(config().apiSecret)",
        ].join("\n"),
      ),
    });
    expect(diagnostics).toHaveLength(4);
  });

  test("uses the generated component inventory and plugin modes after Nuxt prepare", async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-runtime-registration-"));
    const cwd = process.cwd();
    let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined;
    try {
      symlinkSync(
        fileURLToPath(new URL("../../../node_modules", import.meta.url)),
        join(root, "node_modules"),
        "junction",
      );
      const files = {
        "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "^4.5.2" } }),
        "nuxt.config.ts": "export default { srcDir: 'app/' }",
        "app/components/Report.vue": page("const key = useRuntimeConfig().apiSecret"),
        "app/components/Variant.server.vue": "<template><div /></template>",
        "app/components/Variant.client.vue": "<template><div /></template>",
        "app/pages/index.vue": "<template><Report /></template>",
        "app/runtime/auth.ts":
          "export default defineNuxtPlugin({ name: 'auth', env: { islands: false }, setup() {} })",
        "app/runtime/api.client.ts":
          "export default defineNuxtPlugin({ name: 'api', dependsOn: ['auth'], setup() {} })",
      };
      for (const [file, source] of Object.entries(files)) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), source);
      }
      const register = defineNuxtModule({
        setup(_options, app) {
          app.hook("components:extend", (components) => {
            const report = components.find((component) => component.pascalName === "Report");
            if (report) report.mode = "server";
          });
        },
      });
      process.chdir(root);
      nuxt = await loadNuxt({
        cwd: root,
        overrides: {
          _prepare: true,
          srcDir: "app",
          telemetry: false,
          modules: [nuxtDoctorModule, register],
          runtimeConfig: { apiSecret: "private" },
          plugins: [
            { src: join(root, "app/runtime/auth.ts"), mode: "client" },
            { src: join(root, "app/runtime/api.client.ts"), mode: "server" },
          ],
        },
      });
      await buildNuxt(nuxt);
      await nuxt.close();
      nuxt = undefined;
      const generated = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(generated.resolvedComponents).toEqual(
        expect.arrayContaining([
          { name: "Report", file: join(root, "app/components/Report.vue"), mode: "server" },
          {
            name: "Variant",
            file: join(root, "app/components/Variant.server.vue"),
            mode: "server",
          },
          {
            name: "Variant",
            file: join(root, "app/components/Variant.client.vue"),
            mode: "client",
          },
        ]),
      );
      expect(generated.resolvedPlugins).toEqual(
        expect.arrayContaining([
          { file: join(root, "app/runtime/auth.ts"), mode: "client" },
          { file: join(root, "app/runtime/api.client.ts"), mode: "server" },
        ]),
      );
      const scan = async () =>
        (await runViteDoctor({ root, framework: "nuxt", cache: false })).diagnostics.filter(
          ({ code }) => code === "NUXT0102" || code === "NUXT0104",
        );
      expect(await scan()).toEqual([]);
      writeFileSync(join(root, "app/components/README.md"), "# Components");
      expect(await scan()).toEqual([]);
      writeFileSync(
        join(root, "app/pages/raw.vue"),
        page("import Report from '~/components/Report.vue'").replace("<div />", "<Report />"),
      );
      expect(await scan()).toMatchObject([{ code: "NUXT0102", confidence: "heuristic-medium" }]);
    } finally {
      await nuxt?.close();
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lowers confidence for a component whose client rendering it cannot see", async () => {
    const { diagnostics } = await run({
      "app/components/Report.server.vue": page("").replace("<div />", "<SecretRow />"),
      "app/components/SecretRow.vue": page("const key = useRuntimeConfig().apiSecret"),
      "app/pages/index.vue": page("const key = useRuntimeConfig().apiSecret"),
    });

    const byFile = Object.fromEntries(
      diagnostics.map((diagnostic) => [diagnostic.file.split("/app/")[1], diagnostic]),
    );
    expect(diagnostics).toHaveLength(2);
    expect(byFile["components/SecretRow.vue"]?.confidence).toBe("heuristic-medium");
    expect(byFile["components/SecretRow.vue"]?.why).toContain("only server components");
    expect(byFile["pages/index.vue"]?.confidence).toBe("manifest-backed");
  });

  test("stays quiet for a local useRuntimeConfig that shadows Nuxt's", async () => {
    const { diagnostics } = await run({
      "app/pages/index.vue": page(
        "import { useRuntimeConfig } from './config'\nconst key = useRuntimeConfig().apiSecret",
      ),
    });

    expect(diagnostics).toEqual([]);
  });

  test("records an evidence gap instead of guessing without the manifest", async () => {
    const result = await run(
      {
        "app/pages/index.vue": page("const key = useRuntimeConfig().apiSecret"),
        "app/pages/other.vue": page("const key = useRuntimeConfig().token"),
      },
      false,
    );

    expect(result.diagnostics).toEqual([]);
    const gaps = (result.project.evidenceGaps ?? []).filter(
      (gap) => gap.source === "vite-doctor/nuxt-private-runtime-config",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.files).toEqual(
      expect.arrayContaining([".nuxt/doctor.manifest.json", "app/pages/index.vue"]),
    );
  });
});
