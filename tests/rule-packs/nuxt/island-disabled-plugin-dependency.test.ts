import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildNuxt, loadNuxt } from "nuxt/kit";
import { dirname, join } from "pathe";
import { describe, expect, test } from "vite-plus/test";
import type { NuxtDoctorManifest } from "../../../src/core/primitives.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { noIslandDisabledPluginDependency } from "../../../src/rule-packs/nuxt/rules/nuxt/no-island-disabled-plugin-dependency.ts";

function fixture(files: Record<string, string>) {
  return runProjectFixture({
    rules: [noIslandDisabledPluginDependency],
    framework: "nuxt",
    files,
  });
}

const plugin = (body: string) => `export default defineNuxtPlugin({\n${body}\n  setup() {},\n})\n`;
const auth = plugin("  name: 'auth',\n  env: { islands: false },");
const api = plugin("  name: 'api',\n  dependsOn: ['auth'],");
const island = { "app/components/Chart.server.vue": "<template><div /></template>\n" };
const ignoreEvidence = { patterns: [], layerRoots: ["."], fileHash: null };

async function run(files: Record<string, string>, evidence: Partial<NuxtDoctorManifest> = {}) {
  const result = await fixture({
    ".nuxt/doctor.manifest.json": JSON.stringify({
      generatedAt: new Date(Date.now() + 10_000).toISOString(),
      appDir: "app",
      componentIslands: "auto",
      hasServerPageIslands: false,
      appRegistrationIgnore: ignoreEvidence,
      appRegistration: {
        components: { directories: [], files: [] },
        pages: { directories: [], files: [] },
        plugins: { directories: [], files: [] },
      },
      resolvedComponents: [{ name: "Chart", file: Object.keys(island)[0], mode: "server" }],
      resolvedPlugins: Object.keys(files)
        .filter((file) => file.startsWith("app/plugins/"))
        .map((file) => ({ file, mode: file.endsWith(".client.ts") ? "client" : "all" })),
      ...evidence,
    }),
    ...files,
  });
  return result.diagnostics;
}

async function withPreparedApp(
  files: Record<string, string>,
  check: (app: {
    root: string;
    write: (file: string, source: string) => void;
    scan: () => Promise<string[]>;
    prepare: () => Promise<void>;
    gaps: () => Promise<string[]>;
  }) => Promise<void>,
  setup?: (root: string) => void,
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
    setup?.(root);
    process.chdir(root);
    const prepare = async () => {
      nuxt = await loadNuxt({
        cwd: root,
        overrides: { _prepare: true, telemetry: false, modules: [nuxtDoctorModule] },
      });
      await buildNuxt(nuxt);
      await nuxt.close();
      nuxt = undefined;
    };
    await prepare();
    const result = () => runViteDoctor({ root, framework: "nuxt", cache: false });
    await check({
      root,
      write,
      prepare,
      scan: async () =>
        (await result()).diagnostics
          .filter(({ code }) => code === "NUXT0104")
          .map(({ file }) => file),
      gaps: async () => (await result()).project.evidenceGaps?.map(({ source }) => source) ?? [],
    });
  } finally {
    await nuxt?.close();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("nuxt/plugins/no-island-disabled-dependency", () => {
  test("invalidates stale registration when a parent is added through a linked pages directory", async () => {
    await withPreparedApp(
      { "shared-pages/catalog/details.server.vue": "<template><div /></template>" },
      async ({ write, scan, prepare, gaps }) => {
        expect(await scan()).toHaveLength(1);
        write("shared-pages/catalog.vue", "<template><NuxtPage /></template>");
        expect(await scan()).toEqual([]);
        expect(await gaps()).toContain(
          "nuxt/plugins/no-island-disabled-dependency/island-registration",
        );
        await prepare();
        expect(await scan()).toEqual([]);
        expect(await gaps()).not.toContain(
          "nuxt/plugins/no-island-disabled-dependency/island-registration",
        );
      },
      (root) => {
        mkdirSync(join(root, "app/pages"));
        symlinkSync(join(root, "shared-pages"), join(root, "app/pages/linked"), "junction");
      },
    );
  });

  test("checks additions, removals, and renames after Nuxt prepare without re-preparing", async () => {
    await withPreparedApp({}, async ({ root, write, scan, prepare, gaps }) => {
      expect(await scan()).toEqual([]);
      write("app/components/Chart.server.vue", "<template><div /></template>");
      expect(await scan()).toEqual([]);
      expect(await gaps()).toContain(
        "nuxt/plugins/no-island-disabled-dependency/island-registration",
      );
      await prepare();
      expect(await scan()).toEqual([expect.stringMatching(/app\/plugins\/api\.ts$/)]);
      renameSync(join(root, "app/plugins/api.ts"), join(root, "app/plugins/backend.ts"));
      expect(await scan()).toEqual([]);
      expect(await gaps()).toContain(
        "nuxt/plugins/no-island-disabled-dependency/plugin-registration",
      );
      await prepare();
      expect(await scan()).toEqual([expect.stringMatching(/app\/plugins\/backend\.ts$/)]);
    });
    await withPreparedApp(island, async ({ root, scan }) => {
      expect(await scan()).toHaveLength(1);
      rmSync(join(root, "app/components/Chart.server.vue"));
      expect(await scan()).toEqual([]);
    });
  });

  test("does not count a nested server page after Nuxt prepare", async () => {
    const server = "<template><div /></template>";
    await withPreparedApp(
      {
        "app/pages/parent.vue": "<template><NuxtPage /></template>",
        "app/pages/parent/child.server.vue": server,
      },
      async ({ scan }) => expect(await scan()).toEqual([]),
    );
  });

  test.each([
    "app/pages/(marketing)/offer.server.vue",
    "app/pages/[slug].server.vue",
    "app/pages/catalog/index.server.vue",
  ])("counts the registered server page %s after Nuxt prepare", async (file) => {
    await withPreparedApp(
      { [file]: "<template><div /></template>" },
      async ({ root, write, scan }) => {
        expect(await scan()).toHaveLength(1);
        write("app/pages/README.md", "# Pages");
        expect(await scan()).toHaveLength(1);
        rmSync(join(root, file));
        expect(await scan()).toEqual([]);
      },
    );
  });

  test("keeps resolved registrations after unrelated files change", async () => {
    await withPreparedApp(
      {
        ...island,
        ".nuxtignore": "app/plugins/ignored.ts\n",
        "nuxt.config.ts":
          "export default { dir: { assets: 'styles' }, plugins: ['~/runtime/auth'] }",
        "app/plugins/auth.ts": "export default defineNuxtPlugin(() => {})",
        "app/runtime/auth.ts": auth,
      },
      async ({ root, write, scan }) => {
        expect(await scan()).toHaveLength(1);
        write("app/plugins/README.md", "# Plugins");
        write("app/plugins/helpers/format.ts", "export const format = String");
        write("app/plugins/ignored.ts", plugin("  name: 'auth',"));
        write("app/pages/README.md", "# Pages");
        write("app/components/README.md", "# Components");
        expect(await scan()).toHaveLength(1);
        rmSync(join(root, "app/plugins/README.md"));
        expect(await scan()).toHaveLength(1);
        write(".nuxtignore", "");
        expect(await scan()).toEqual([]);
      },
    );
  });

  test("records an evidence gap instead of guessing registration without Nuxt prepare", async () => {
    const result = await fixture({
      ...island,
      "app/pages/[slug].server.vue": "<template><div /></template>",
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.project.evidenceGaps).toContainEqual(
      expect.objectContaining({
        source: "nuxt/plugins/no-island-disabled-dependency/island-registration",
      }),
    );
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
          appRegistrationIgnore: ignoreEvidence,
          hasServerPageIslands: false,
          appRegistration: {
            components: {
              directories: [
                { path: "app/components", patterns: ["**/*.vue"], entries: ["Chart.server.vue"] },
              ],
              files: [],
            },
            pages: {
              directories: [{ path: "app/pages", patterns: ["**/*.vue"], entries: [] }],
              files: [],
            },
            plugins: {
              directories: [{ path: "app/plugins", patterns: ["*.ts"], entries: ["api.ts"] }],
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
    await withPreparedApp(
      {
        "nuxt.config.ts":
          "export default defineNuxtConfig({ experimental: { componentIslands: true } })\n",
        "app/components/Feed.island.vue": "<template><div /></template>\n",
        "app/plugins/auth.ts": "export default defineNuxtPlugin(() => {})",
        "app/plugins/api.ts": "export default defineNuxtPlugin(() => {})",
        "app/plugins/auth/index.ts": auth,
        "app/plugins/02.api.server.ts": api,
      },
      async ({ scan }) =>
        expect(await scan()).toEqual([expect.stringMatching(/02\.api\.server\.ts$/)]),
    );
  });

  test("stays quiet when islands are off or nothing renders as an island", async () => {
    const off = await run(
      {
        ...island,
        "nuxt.config.ts":
          "export default defineNuxtConfig({ experimental: { componentIslands: false } })\n",
        "app/plugins/auth.ts": auth,
        "app/plugins/api.ts": api,
      },
      { componentIslands: false },
    );
    const noIslands = await run(
      {
        "app/components/Chart.server.vue": "<template><div /></template>\n",
        "app/components/Chart.client.vue": "<template><div /></template>\n",
        "app/plugins/auth.ts": auth,
        "app/plugins/api.ts": api,
      },
      {
        resolvedComponents: [
          { name: "Chart", file: "app/components/Chart.server.vue", mode: "server" },
          { name: "Chart", file: "app/components/Chart.client.vue", mode: "client" },
        ],
      },
    );

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

  test("stays quiet when plugin names or env cannot be resolved", async () => {
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
    const unknownDependency = await run({
      ...island,
      "app/plugins/api.ts": plugin("  name: 'api',\n  dependsOn: ['nuxt-auth'],"),
    });

    expect(duplicate).toEqual([]);
    expect(computedName).toEqual([]);
    expect(computedEnv).toEqual([]);
    expect(unknownDependency).toEqual([]);
  });
});
