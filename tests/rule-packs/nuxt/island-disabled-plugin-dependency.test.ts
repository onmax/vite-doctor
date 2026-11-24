import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildNuxt, loadNuxt } from "nuxt/kit";
import { dirname, join } from "pathe";
import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { noIslandDisabledPluginDependency } from "../../../src/rule-packs/nuxt/rules/nuxt/no-island-disabled-plugin-dependency.ts";

async function run(files: Record<string, string>) {
  const result = await runProjectFixture({
    rules: [noIslandDisabledPluginDependency],
    framework: "nuxt",
    files,
  });
  return result.diagnostics;
}

const plugin = (body: string) => `export default defineNuxtPlugin({\n${body}\n  setup() {},\n})\n`;
const auth = plugin("  name: 'auth',\n  env: { islands: false },");
const api = plugin("  name: 'api',\n  dependsOn: ['auth'],");
const island = { "app/components/Chart.server.vue": "<template><div /></template>\n" };

async function withPreparedApp(
  files: Record<string, string>,
  check: (app: {
    root: string;
    write: (file: string, source: string) => void;
    scan: () => Promise<string[]>;
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "doctor-island-registration-"));
  const cwd = process.cwd();
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined;
  const write = (file: string, source: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  };
  try {
    symlinkSync(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      join(root, "node_modules"),
      "junction",
    );
    write("package.json", JSON.stringify({ type: "module", dependencies: { nuxt: "^4.5.2" } }));
    write("nuxt.config.ts", "export default defineNuxtConfig({})");
    write("app/plugins/auth.ts", auth);
    write("app/plugins/api.ts", api);
    for (const [file, source] of Object.entries(files)) write(file, source);
    process.chdir(root);
    nuxt = await loadNuxt({
      cwd: root,
      overrides: { _prepare: true, telemetry: false, modules: [nuxtDoctorModule] },
    });
    await buildNuxt(nuxt);
    await nuxt.close();
    nuxt = undefined;
    await check({
      root,
      write,
      scan: async () =>
        (await runViteDoctor({ root, framework: "nuxt", cache: false })).diagnostics
          .filter(({ code }) => code === "NUXT0104")
          .map(({ file }) => file),
    });
  } finally {
    await nuxt?.close();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("nuxt/plugins/no-island-disabled-dependency", () => {
  test("checks additions, removals, and renames after Nuxt prepare without re-preparing", async () => {
    await withPreparedApp({}, async ({ root, write, scan }) => {
      expect(await scan()).toEqual([]);
      write("app/components/Chart.server.vue", "<template><div /></template>");
      expect(await scan()).toEqual([expect.stringMatching(/app\/plugins\/api\.ts$/)]);
      renameSync(join(root, "app/plugins/api.ts"), join(root, "app/plugins/backend.ts"));
      expect(await scan()).toEqual([expect.stringMatching(/app\/plugins\/backend\.ts$/)]);
    });
    await withPreparedApp(island, async ({ root, scan }) => {
      expect(await scan()).toHaveLength(1);
      rmSync(join(root, "app/components/Chart.server.vue"));
      expect(await scan()).toEqual([]);
    });
  });

  test("only counts server pages registered as islands after Nuxt prepare", async () => {
    const server = "<template><div /></template>";
    await withPreparedApp(
      {
        "app/pages/parent.vue": "<template><NuxtPage /></template>",
        "app/pages/parent/child.server.vue": server,
      },
      async ({ scan }) => expect(await scan()).toEqual([]),
    );
    await withPreparedApp(
      {
        "app/pages/standalone.server.vue": server,
      },
      async ({ scan }) => expect(await scan()).toHaveLength(1),
    );
  });

  test("uses default island roots and withholds reports for unknown or disabled registration", async () => {
    const plugins = { "app/plugins/auth.ts": auth, "app/plugins/api.ts": api };
    expect(
      await run({ ...plugins, "app/components/islands/Chart.vue": "<template><div /></template>" }),
    ).toHaveLength(1);
    expect(
      await run({ ...plugins, "app/utils/Chart.server.vue": "<template><div /></template>" }),
    ).toEqual([]);
    expect(
      await run({
        ...plugins,
        ...island,
        "nuxt.config.ts": "export default defineNuxtConfig({ components: false })",
      }),
    ).toEqual([]);
    expect(
      await run({
        ...plugins,
        ...island,
        "nuxt.config.ts":
          "const enabled = false; export default defineNuxtConfig({ experimental: { componentIslands: enabled } })",
      }),
    ).toEqual([]);
  });

  test("reports a plugin that depends on an island-disabled plugin when the app renders islands", async () => {
    const diagnostics = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("NUXT0104");
    expect(diagnostics[0]?.severity).toBe("warn");
    expect(diagnostics[0]?.file).toMatch(/app\/plugins\/api\.ts$/);
    expect(diagnostics[0]?.range?.line).toBe(3);
    expect(diagnostics[0]?.why).toContain("'auth'");
    expect(diagnostics[0]?.why).toContain("islands: false");
    expect(diagnostics[0]?.related?.[0]?.file).toMatch(/app\/plugins\/auth\.ts$/);
    expect(diagnostics[0]?.related?.[0]?.range?.line).toBe(3);
  });

  test("prefers resolved plugin modes and an authoritative empty component inventory", async () => {
    const files = { ...island, "app/runtime/auth.client.ts": auth, "app/plugins/api.ts": api };
    const withInventory = (
      authMode: "client" | "server",
      apiMode: "client" | "server",
      hasIsland: boolean,
    ) =>
      run({
        ...files,
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: new Date(Date.now() + 10_000).toISOString(),
          nuxtVersion: "4.5.2",
          appDir: "app",
          autoImports: [],
          components: [],
          layers: [],
          componentIslands: "auto",
          hasServerPageIslands: false,
          appRegistration: {
            components: { directories: { "app/components": ["Chart.server.vue"] }, files: [] },
            pages: { directories: { "app/pages": [] }, files: [] },
            plugins: {
              directories: { "app/plugins": ["api.ts"] },
              files: ["app/runtime/auth.client.ts"],
            },
          },
          resolvedComponents: hasIsland
            ? [{ name: "Chart", file: "app/components/Chart.server.vue", mode: "server" }]
            : [],
          resolvedPlugins: [
            { file: "app/runtime/auth.client.ts", mode: authMode },
            { file: "app/plugins/api.ts", mode: apiMode },
          ],
        }),
      });
    expect(await withInventory("server", "server", true)).toHaveLength(1);
    expect(await withInventory("client", "server", true)).toEqual([]);
    expect(await withInventory("server", "client", true)).toEqual([]);
    expect(await withInventory("server", "server", false)).toEqual([]);
  });

  test("reports island components and index plugins with explicitly enabled islands", async () => {
    const diagnostics = await run({
      "nuxt.config.ts":
        "export default defineNuxtConfig({ experimental: { componentIslands: true } })\n",
      "app/components/Feed.island.vue": "<template><div /></template>\n",
      "app/plugins/auth/index.ts": auth,
      "app/plugins/02.api.server.ts": api,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toMatch(/02\.api\.server\.ts$/);
  });

  test("stays quiet when islands are off or nothing renders as an island", async () => {
    const off = await run({
      ...island,
      "nuxt.config.ts":
        "export default defineNuxtConfig({ experimental: { componentIslands: false } })\n",
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });
    const noIslands = await run({
      "app/components/Chart.server.vue": "<template><div /></template>\n",
      "app/components/Chart.client.vue": "<template><div /></template>\n",
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });

    expect(off).toEqual([]);
    expect(noIslands).toEqual([]);
  });

  test("stays quiet when the dependent also opts out, or either side is client-only", async () => {
    const both = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": plugin(
        "  name: 'api',\n  dependsOn: ['auth'],\n  env: { islands: false },",
      ),
    });
    const clientDependency = await run({
      ...island,
      "app/plugins/auth.client.ts": auth,
      "app/plugins/api.ts": api,
    });
    const clientDependent = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/api.client.ts": api,
    });

    expect(both).toEqual([]);
    expect(clientDependency).toEqual([]);
    expect(clientDependent).toEqual([]);
  });

  test("stays quiet when names or config cannot be resolved", async () => {
    const duplicate = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/auth-fallback.ts": plugin("  name: 'auth',"),
      "app/plugins/api.ts": api,
    });
    const computedName = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/other.ts": plugin("  name: pluginName,"),
      "app/plugins/api.ts": api,
    });
    const computedEnv = await run({
      ...island,
      "app/plugins/auth.ts": plugin("  name: 'auth',\n  env: { islands: !import.meta.dev },"),
      "app/plugins/api.ts": api,
    });
    const spreadConfig = await run({
      ...island,
      "nuxt.config.ts": "export default defineNuxtConfig({ ...base })\n",
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });
    const unknownDependency = await run({
      ...island,
      "app/plugins/api.ts": plugin("  name: 'api',\n  dependsOn: ['nuxt-auth'],"),
    });

    expect(duplicate).toEqual([]);
    expect(computedName).toEqual([]);
    expect(computedEnv).toEqual([]);
    expect(spreadConfig).toEqual([]);
    expect(unknownDependency).toEqual([]);
  });
});
