import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noPrivateRuntimeConfigInClient } from "../../../src/rule-packs/nuxt/rules/nuxt/no-private-runtime-config-in-client.ts";

const manifest = JSON.stringify({
  generatedAt: new Date(Date.now() + 10_000).toISOString(),
  nuxtVersion: "4.5.2",
  appDir: "app",
  autoImportEnabled: true,
  autoImports: [
    { name: "useRuntimeConfig", from: "#app/nuxt", kind: "nuxt" },
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

  test("stays quiet for a component Nuxt resolved as server-only", async () => {
    const withServerComponent = manifest.replace(
      '"components":[]',
      JSON.stringify({
        components: [{ name: "Report", file: "app/components/Report.vue", mode: "server" }],
      }).slice(1, -1),
    );
    const { diagnostics } = await runProjectFixture({
      rules: [noPrivateRuntimeConfigInClient],
      framework: "nuxt",
      files: {
        ".nuxt/doctor.manifest.json": withServerComponent,
        "app/components/Report.vue": page("const key = useRuntimeConfig().apiSecret"),
      },
    });

    expect(diagnostics).toEqual([]);
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
