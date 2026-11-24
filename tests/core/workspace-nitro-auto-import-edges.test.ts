import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { importModule } from "nuxt/kit";
import { dirname, join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  createRule,
  defineDoctorExtension,
  defineRulePack,
  type ImportGraph,
} from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import nuxtDoctorModule from "../../src/rule-packs/nuxt/module.ts";

const cycleRule = "workspace/dead-code/circular-dependency";

const useA = "export function useA() {\n  return useB() + 1\n}\n";
const useB = "export function useB(n = 0) {\n  return n > 0 ? useA() : 0\n}\n";

interface ManifestOptions {
  serverDir?: string;
  nitroAutoImportEnabled?: boolean;
  nitroAutoImports?: ((root: string) => unknown[]) | false;
}

function manifestFor(root: string, options: ManifestOptions) {
  const serverDir = join(root, options.serverDir ?? "server");
  const nitroAutoImports = options.nitroAutoImports ?? (() => []);
  return JSON.stringify({
    nuxtVersion: "4.4.6",
    vueVersion: "3.5",
    rootDir: root,
    srcDir: join(root, "app"),
    appDir: join(root, "app"),
    buildDir: join(root, ".nuxt"),
    generatedAt: new Date(Date.now() + 1000).toISOString(),
    autoImportEnabled: true,
    autoImports: [
      { name: "ref", from: "vue", kind: "vue" },
      { name: "useApp", from: join(root, "app/composables/useApp.ts"), kind: "app" },
    ],
    nitroAutoImportEnabled: options.nitroAutoImportEnabled ?? true,
    nitroAutoImports:
      nitroAutoImports === false
        ? undefined
        : [
            { name: "defineEventHandler", from: "h3" },
            { name: "useA", from: join(serverDir, "utils/a.ts") },
            { name: "useB", from: join(serverDir, "utils/b.ts") },
            ...nitroAutoImports(root),
          ],
    components: [],
    layers: [{ root, priority: 0, serverDir }],
    routeRules: {},
    serverHandlers: [],
    modules: [],
    moduleSources: [],
  });
}

function writeFixture(root: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

async function analyze(root: string) {
  let graph: ImportGraph | undefined;
  const capture = createRule({
    meta: {
      id: "test/import-graph",
      title: "Capture the import graph",
      category: "architecture",
      severity: "info",
      execution: "workspace",
      cacheScope: "none",
    },
    create(ctx) {
      return {
        async onWorkspaceEnd() {
          graph = await ctx.inventory.importGraph();
        },
      };
    },
  });
  const result = await runViteDoctor({
    root,
    framework: "nuxt",
    analyses: "graph",
    rules: `test/import-graph,${cycleRule}`,
    cache: false,
    extensions: [
      defineDoctorExtension({
        name: "capture",
        rulePacks: [
          defineRulePack({
            name: "capture",
            version: "0.0.0",
            rules: [capture],
            presets: { recommended: [capture.meta.id] },
          }),
        ],
      }),
    ],
  });
  if (!graph) throw new Error("The capture Rule did not run.");
  const rel = (file?: string) => file && relative(root, file);
  return {
    cycles: result.diagnostics
      .filter((item) => item.ruleId === cycleRule)
      .map((item) => ({
        message: item.message,
        related: item.related?.map((entry) => ({
          file: rel(entry.file),
          line: entry.range?.line,
          column: entry.range?.column,
          message: entry.message,
        })),
      })),
    autoImportEdges: graph.edges
      .filter((edge) => edge.kind === "auto-import")
      .map((edge) => `${rel(edge.from)} -${edge.specifier}-> ${rel(edge.to)}`),
    graph,
    rel,
    gaps: (result.project.evidenceGaps ?? []).map((gap) => gap.message),
  };
}

async function run(files: Record<string, string>, options: ManifestOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-nitro-auto-import-edges-"));
  try {
    writeFixture(root, {
      "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.4.6" } }),
      ".nuxt/doctor.manifest.json": manifestFor(root, options),
      ...files,
    });
    return await analyze(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("server utils that call each other through Nitro auto-imports form a DOC0001 cycle", async () => {
  const { cycles, autoImportEdges, graph, rel } = await run({
    "server/utils/a.ts": useA,
    "server/utils/b.ts": useB,
    "server/api/count.ts": "export default defineEventHandler(() => useA())\n",
  });
  expect(autoImportEdges).toEqual([
    "server/api/count.ts -useA-> server/utils/a.ts",
    "server/utils/a.ts -useB-> server/utils/b.ts",
    "server/utils/b.ts -useA-> server/utils/a.ts",
  ]);
  expect(cycles).toEqual([
    {
      message: "Circular import: server/utils/a.ts → server/utils/b.ts → server/utils/a.ts.",
      related: [
        {
          file: "server/utils/a.ts",
          line: 2,
          column: 10,
          message: "uses auto-imported `useB` → server/utils/b.ts",
        },
        {
          file: "server/utils/b.ts",
          line: 2,
          column: 18,
          message: "uses auto-imported `useA` → server/utils/a.ts",
        },
      ],
    },
  ]);
  expect(graph.cycles.map((cycle) => cycle.files.map(rel))).toEqual([
    ["server/utils/a.ts", "server/utils/b.ts"],
  ]);
});

test("a one-way Nitro auto-import is an edge but not a cycle", async () => {
  const { cycles, autoImportEdges } = await run({
    "server/utils/a.ts": useA,
    "server/utils/b.ts": "export function useB() {\n  return 1\n}\n",
  });
  expect(autoImportEdges).toEqual(["server/utils/a.ts -useB-> server/utils/b.ts"]);
  expect(cycles).toEqual([]);
});

test("a local binding in a server file shadows the Nitro auto-import", async () => {
  const { cycles, autoImportEdges } = await run({
    "server/utils/a.ts": useA,
    "server/utils/b.ts": "const useA = () => 1\nexport function useB() {\n  return useA()\n}\n",
  });
  expect(autoImportEdges).toEqual(["server/utils/a.ts -useB-> server/utils/b.ts"]);
  expect(cycles).toEqual([]);
});

test("server files never resolve app auto-imports, and app files never resolve Nitro ones", async () => {
  const { autoImportEdges, cycles } = await run({
    "app/composables/useApp.ts": "export const useApp = () => 1\n",
    "app/composables/useB.ts": "export const useB = () => useApp()\n",
    "server/utils/a.ts": "export const useA = () => 1\n",
    "server/utils/b.ts": "export const useB = () => 2\n",
    "server/api/app.ts": "export default defineEventHandler(() => useApp())\n",
    "app/pages/index.vue":
      '<script setup lang="ts">\nconst value = useA() + useB()\n</script>\n<template>{{ value }}</template>\n',
  });
  expect(autoImportEdges).toEqual(["app/composables/useB.ts -useApp-> app/composables/useApp.ts"]);
  expect(cycles).toEqual([]);
});

test("a manifest without Nitro's registry gives no server edges and reports the gap", async () => {
  const { autoImportEdges, cycles, gaps } = await run(
    {
      "app/composables/useApp.ts": "export const useApp = () => 1\n",
      "app/pages/index.vue":
        '<script setup lang="ts">\nconst value = useApp()\n</script>\n<template>{{ value }}</template>\n',
      "server/utils/a.ts": useA,
      "server/utils/b.ts": useB,
    },
    { nitroAutoImportEnabled: undefined, nitroAutoImports: false },
  );
  expect(autoImportEdges).toEqual(["app/pages/index.vue -useApp-> app/composables/useApp.ts"]);
  expect(cycles).toEqual([]);
  expect(gaps).toEqual([
    expect.stringContaining(
      ".nuxt/doctor.manifest.json does not record Nitro's auto-imports, so Doctor cannot prove which names Nitro auto-imports into server files",
    ),
  ]);
});

test("a Nitro registry entry whose file no longer exports it withholds server edges", async () => {
  const { autoImportEdges, gaps } = await run({
    "server/utils/a.ts": useA,
    "server/utils/b.ts": "export function useRenamed() {\n  return useA()\n}\n",
  });
  expect(autoImportEdges).toEqual([]);
  expect(gaps).toEqual([
    expect.stringContaining(
      "lists `useB` from server/utils/b.ts, which no longer exports it, so the Nitro auto-import registry predates source edits",
    ),
  ]);
});

test("disabled Nitro auto-imports give no server edges and no gap", async () => {
  const { autoImportEdges, gaps } = await run(
    { "server/utils/a.ts": useA, "server/utils/b.ts": useB },
    { nitroAutoImportEnabled: false, nitroAutoImports: false },
  );
  expect(autoImportEdges).toEqual([]);
  expect(gaps).toEqual([]);
});

test("a layer's configured serverDir resolves against the Nitro registry", async () => {
  const { autoImportEdges, cycles } = await run(
    {
      "backend/utils/a.ts": useA,
      "backend/utils/b.ts": useB,
      "server/utils/c.ts": "export const useC = () => useA()\n",
    },
    { serverDir: "backend" },
  );
  expect(autoImportEdges).toEqual([
    "backend/utils/a.ts -useB-> backend/utils/b.ts",
    "backend/utils/b.ts -useA-> backend/utils/a.ts",
  ]);
  expect(cycles).toHaveLength(1);
});

test("the Nuxt module records Nitro's resolved registry, which closes the server cycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-nitro-auto-import-manifest-"));
  try {
    writeFixture(root, {
      "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.4.6" } }),
      "server/utils/a.ts": useA,
      "server/utils/b.ts": useB,
      "server/utils/types.ts": "export interface Account {\n  id: string\n}\n",
      "app/composables/useApp.ts": "export const useApp = () => 1\n",
    });
    const { createUnimport } = await importModule<{
      createUnimport: (options: unknown) => { init: () => Promise<void> };
    }>("unimport", { url: new URL(import.meta.resolve("nuxt")) });
    const imports = {
      autoImport: true,
      dirs: [join(root, "server/utils/**/*")],
      imports: [{ name: "useA", as: "useServerA", from: "#server/utils/a" }],
    };
    const unimport = createUnimport(imports);
    await unimport.init();
    const hooks = new Map<string, (payload?: any) => unknown>();
    await nuxtDoctorModule({}, {
      _version: "4.4.6",
      options: { rootDir: root, srcDir: join(root, "app"), buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    } as any);
    await hooks.get("nitro:init")!({
      options: { imports, alias: { "#server": join(root, "server") }, handlers: [] },
      unimport,
      scannedHandlers: [],
      hooks: { hook() {} },
    });
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.nitroAutoImportEnabled).toBe(true);
    expect(
      manifest.nitroAutoImports.map(
        (entry: { name: string; as?: string; from: string; type?: boolean }) =>
          `${entry.as ?? entry.name} ${relative(root, entry.from)}${entry.type ? " type" : ""}`,
      ),
    ).toEqual(["useServerA server/utils/a", "useA server/utils/a.ts", "useB server/utils/b.ts"]);
    const { autoImportEdges, cycles } = await analyze(root);
    expect(autoImportEdges).toEqual([
      "server/utils/a.ts -useB-> server/utils/b.ts",
      "server/utils/b.ts -useA-> server/utils/a.ts",
    ]);
    expect(cycles).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
