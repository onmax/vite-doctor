import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join, relative } from "pathe";
import { expect, test, vi } from "vite-plus/test";
import {
  createRule,
  defineDoctorExtension,
  defineRulePack,
  type ImportGraph,
  type RuntimeTarget,
} from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { captureNitroAutoImportScan } from "../../src/core/internal/nitro-auto-import-scan.ts";
import { createUnimport } from "unimport";
import nuxtDoctorModule from "../../src/rule-packs/nuxt/module.ts";

const cycleRule = "workspace/dead-code/circular-dependency";

const useA = "export function useA() {\n  return useB() + 1\n}\n";
const useB = "export function useB(n = 0) {\n  return n > 0 ? useA() : 0\n}\n";

interface ManifestOptions {
  serverDir?: string;
  nitroAutoImportEnabled?: boolean;
  nitroAutoImports?: ((root: string) => unknown[]) | false;
}

async function manifestFor(root: string, options: ManifestOptions) {
  const serverDir = join(root, options.serverDir ?? "server");
  const imports = { dirs: [join(serverDir, "utils/**/*")] };
  const unimport = createUnimport(imports);
  await unimport.init();
  const nitroAutoImports = options.nitroAutoImports ?? (() => []);
  const appImports = [
    { name: "ref", from: "vue", kind: "vue" },
    { name: "useApp", from: join(root, "app/composables/useApp.ts"), kind: "app" },
  ];
  return JSON.stringify({
    nuxtVersion: "4.4.6",
    vueVersion: "3.5",
    rootDir: root,
    srcDir: join(root, "app"),
    appDir: join(root, "app"),
    buildDir: join(root, ".nuxt"),
    generatedAt: new Date(Date.now() + 1000).toISOString(),
    autoImportEnabled: true,
    autoImports: appImports,
    runtimeAutoImports: appImports,
    nitroAutoImportEnabled: options.nitroAutoImportEnabled ?? true,
    nitroAutoImportCustomResolver: false,
    nitroAutoImportScan: await captureNitroAutoImportScan(
      await import("unimport"),
      unimport.version,
      imports,
      await unimport.getImportMap(),
    ),
    nitroAutoImportTransform: {
      include: [{ source: String.raw`\.[jt]sx?$`, flags: "" }],
      exclude: [],
      commentsDisable: [],
    },
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

async function analyze(root: string, hostExtensions = false, runtimeTarget?: RuntimeTarget) {
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
    hostExtensions,
    runtimeTarget,
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
    summary: result.graph,
    rel,
    gaps: (result.project.evidenceGaps ?? []).map((gap) => gap.message),
  };
}

async function run(files: Record<string, string>, options: ManifestOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-nitro-auto-import-edges-"));
  try {
    writeFixture(root, {
      "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.4.6" } }),
      ...files,
    });
    writeFixture(root, { ".nuxt/doctor.manifest.json": await manifestFor(root, options) });
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

async function withNitroManifest(
  files: Record<string, string>,
  check: (root: string, rewriteManifest: () => Promise<void>) => Promise<void>,
  options: {
    appAutoImport?: boolean;
    extraScanDir?: boolean;
    extraImportDirs?: string[];
    handler?: string;
    imports?: Record<string, unknown>;
    appImports?: Record<string, string | { name: string; file: string }>;
    appPlugins?: Array<{ file: string; mode: "server" | "all" }>;
    appMiddleware?: string[];
    beforeInit?: (root: string) => void;
    afterInit?: (root: string) => void;
    scannerVersion?: string;
    relativeTransformPaths?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "doctor-nitro-auto-import-manifest-"));
  try {
    writeFixture(root, {
      "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.4.6" } }),
      "server/utils/a.ts": useA,
      "server/utils/b.ts": useB,
      "server/utils/types.ts": "export interface Account {\n  id: string\n}\n",
      "app/composables/useApp.ts": "export const useApp = () => 1\n",
      ...files,
    });
    const nuxtPackage = createRequire(import.meta.url).resolve("nuxt/package.json");
    mkdirSync(join(root, "node_modules"));
    if (options.scannerVersion) {
      const nuxt = "node_modules/nuxt";
      const server = `${nuxt}/node_modules/@nuxt/nitro-server`;
      const nitro = `${server}/node_modules/nitropack`;
      const scanner = `${nitro}/node_modules/unimport`;
      const version = options.scannerVersion;
      const installed = pathToFileURL(createRequire(import.meta.url).resolve("unimport")).href;
      writeFixture(root, {
        [`${nuxt}/package.json`]: JSON.stringify({
          name: "nuxt",
          version: "4.5.2",
          dependencies: { "@nuxt/nitro-server": "4.5.2" },
        }),
        [`${server}/package.json`]: JSON.stringify({
          name: "@nuxt/nitro-server",
          version: "4.5.2",
          dependencies: { nitropack: "2.13.4" },
        }),
        [`${nitro}/package.json`]: JSON.stringify({
          name: "nitropack",
          version: "2.13.4",
          dependencies: { unimport: "^6.2.0" },
        }),
        [`${scanner}/package.json`]: JSON.stringify({
          name: "unimport",
          version,
          main: "index.mjs",
        }),
        [`${scanner}/index.mjs`]: `import { createUnimport as create } from ${JSON.stringify(installed)};
export { scanDirExports } from ${JSON.stringify(installed)};
export const version = ${JSON.stringify(version)};
export const createUnimport = (options) => ({ ...create(options), version });`,
      });
    } else {
      symlinkSync(dirname(nuxtPackage), join(root, "node_modules/nuxt"), "junction");
    }
    const projectRequire = createRequire(join(root, "package.json"));
    const nuxtRequire = createRequire(projectRequire.resolve("nuxt/package.json"));
    const serverRequire = createRequire(nuxtRequire.resolve("@nuxt/nitro-server/package.json"));
    const nitroRequire = createRequire(serverRequire.resolve("nitropack/package.json"));
    const { createUnimport: createNitroUnimport }: typeof import("unimport") = await import(
      pathToFileURL(nitroRequire.resolve("unimport")).href
    );
    const scanDirs = [join(root, "server"), ...(options.extraScanDir ? [join(root, "extra")] : [])];
    const imports = {
      autoImport: true,
      dirs: [
        ...scanDirs.map((dir) => join(dir, "utils/**/*")),
        ...(options.extraImportDirs ?? []).map((dir) => join(root, dir)),
      ],
      imports: [{ name: "useA", as: "useServerA", from: "#server/utils/a" }],
      ...options.imports,
    };
    const unimport = createNitroUnimport(imports);
    options.beforeInit?.(root);
    await unimport.init();
    options.afterInit?.(root);
    const hooks = new Map<string, (payload?: any) => unknown>();
    await nuxtDoctorModule({}, {
      _version: "4.4.6",
      apps: (options.appPlugins || options.appMiddleware) && {
        default: {
          plugins: options.appPlugins?.map(({ file, mode }) => ({ src: join(root, file), mode })),
          middleware: options.appMiddleware?.map((file) => ({ path: join(root, file) })),
        },
      },
      options: {
        rootDir: root,
        srcDir: join(root, "app"),
        buildDir: ".nuxt",
        modules: [],
        extensions: [".ts", ".vue"],
        ...((options.appPlugins || options.appMiddleware) && { _layers: [] }),
        imports: { autoImport: options.appAutoImport ?? true },
      },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    } as any);
    await hooks.get("imports:context")!(
      createUnimport({
        imports: Object.entries<string | { name: string; file: string }>({
          useApp: "app/composables/useApp.ts",
          ...options.appImports,
        }).map(([alias, entry]) => ({
          name: typeof entry === "string" ? alias : entry.name,
          as: alias,
          from: join(root, typeof entry === "string" ? entry : entry.file),
        })),
      }),
    );
    const nitroHooks = new Map<string, () => Promise<void>>();
    const cwd = options.relativeTransformPaths
      ? vi.spyOn(process, "cwd").mockReturnValue(root)
      : undefined;
    try {
      await hooks.get("nitro:init")!({
        options: {
          imports,
          scanDirs,
          alias: { "#server": join(root, "server") },
          handlers: options.handler
            ? [{ handler: join(root, options.handler), route: "/test" }]
            : [],
        },
        unimport,
        scannedHandlers: [],
        hooks: {
          hook: (name: string, callback: () => Promise<void>) => nitroHooks.set(name, callback),
        },
      });
    } finally {
      cwd?.mockRestore();
    }
    if (options.appPlugins || options.appMiddleware) await hooks.get("app:templatesGenerated")!();
    await check(root, nitroHooks.get("compiled")!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("trusted analysis replays the scanner installed under Nitro, not Doctor's version", () =>
  withNitroManifest(
    {},
    async (root) => {
      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.nitroAutoImportScan?.version).toBe("6.5.0");
      const trusted = await analyze(root, true);
      expect(trusted.cycles).toHaveLength(1);
      expect(trusted.gaps).toEqual([]);
      const targeted = await analyze(root, true, { nitro: "2.13.4" });
      expect(targeted.autoImportEdges).toEqual(trusted.autoImportEdges);
      expect(targeted.cycles).toEqual(trusted.cycles);
      expect(targeted.gaps).toEqual([]);
      const standalone = await analyze(root);
      expect(standalone.cycles).toEqual([]);
      expect(standalone.gaps).toEqual([expect.stringContaining("--host-extensions")]);
      writeFixture(root, { "server/utils/b.ts": `${useB}\nexport const newUtil = 1\n` });
      expect((await analyze(root, true)).gaps).toEqual([
        expect.stringContaining("Nitro's auto-import scan inputs changed"),
      ]);
    },
    { scannerVersion: "6.5.0" },
  ));

test("the Nuxt module records Nitro's resolved registry, which closes the server cycle", () =>
  withNitroManifest({}, async (root) => {
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
  }));

test("Nitro injection works independently of disabled app auto-imports", () =>
  withNitroManifest(
    {},
    async (root) => {
      const { autoImportEdges, cycles } = await analyze(root);
      expect(autoImportEdges).toEqual([
        "server/utils/a.ts -useB-> server/utils/b.ts",
        "server/utils/b.ts -useA-> server/utils/a.ts",
      ]);
      expect(cycles).toHaveLength(1);
    },
    { appAutoImport: false },
  ));

test.each([
  { kind: "scanDir", extraScanDir: true },
  { kind: "imports.dirs", extraImportDirs: ["extra/utils/**/*"] },
])(
  "a cycle can cross the layer serverDir and an extra Nitro $kind",
  ({ kind: _kind, ...options }) =>
    withNitroManifest(
      { "server/utils/b.ts": "export const other = 1", "extra/utils/b.ts": useB },
      async (root) => {
        const { autoImportEdges, cycles } = await analyze(root);
        expect(autoImportEdges).toEqual([
          "extra/utils/b.ts -useA-> server/utils/a.ts",
          "server/utils/a.ts -useB-> extra/utils/b.ts",
        ]);
        expect(cycles).toHaveLength(1);
      },
      options,
    ),
);

test("configured Nitro handlers and their imports use the server registry outside scan roots", () =>
  withNitroManifest(
    {
      "lib/handler.ts": "export { handler as default } from './nested'",
      "lib/nested.ts": "export const handler = () => useA()",
      "server/utils/a.ts":
        "import handler from '../../lib/handler'; export const useA = () => handler()",
    },
    async (root) => {
      const { autoImportEdges, cycles } = await analyze(root);
      expect(autoImportEdges).toContain("lib/nested.ts -useA-> server/utils/a.ts");
      expect(cycles.some((cycle) => cycle.message.includes("lib/nested.ts"))).toBe(true);
    },
    { handler: "lib/handler.ts" },
  ));

test("custom import dirs do not make unreachable files Nitro consumers", () =>
  withNitroManifest(
    {
      "lib/unused.ts": "export const unused = () => useA()",
      "app/utils/appOnly.ts": "export const appOnly = () => [useA(), useApp()]",
    },
    async (root) => {
      const { autoImportEdges, gaps } = await analyze(root);
      expect(
        autoImportEdges.filter((edge) => edge.startsWith("lib/") || edge.startsWith("app/")),
      ).toEqual(["app/utils/appOnly.ts -useApp-> app/composables/useApp.ts"]);
      expect(gaps).toContainEqual(expect.stringContaining("cannot establish their runtime bundle"));
    },
    { extraImportDirs: ["lib/**/*", "app/utils/**/*"] },
  ));

test("a shared consumer resolves auto-imports independently in Nuxt and Nitro", () =>
  withNitroManifest(
    {
      "app/app.vue": "<script setup>useShared()</script>",
      "lib/shared.ts": "export const useShared = () => useValue()",
      "lib/app-value.ts":
        "import { useShared } from './shared'; export const useValue = () => useShared()",
      "server/utils/value.ts": "export const useValue = () => 42",
      "server/api/shared.ts": "export { useShared as default } from '../../lib/shared'",
      "server/utils/a.ts": "export const useA = () => 1",
      "server/utils/b.ts": "export const useB = () => 2",
    },
    async (root) => {
      const { autoImportEdges, cycles } = await analyze(root);
      expect(autoImportEdges).toContain("lib/shared.ts -useValue-> lib/app-value.ts");
      expect(autoImportEdges).toContain("lib/shared.ts -useValue-> server/utils/value.ts");
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.message).toContain("lib/app-value.ts → lib/shared.ts → lib/app-value.ts");
    },
    { appImports: { useShared: "lib/shared.ts", useValue: "lib/app-value.ts" } },
  ));

test("edges from different bundles cannot form a single cycle", () =>
  withNitroManifest(
    {
      "app/app.vue": "<script setup>useShared()</script>",
      "lib/shared.ts":
        "export const useShared = () => useValue(); export const useNitroShared = useShared",
      "lib/app-value.ts": "export const useValue = () => useNitroShared()",
      "server/api/shared.ts": "export { useValue as default } from '../../lib/app-value'",
      "server/utils/a.ts": "export const useA = () => 1",
      "server/utils/b.ts": "export const useB = () => 2",
    },
    async (root) => {
      const { graph, rel, cycles, summary } = await analyze(root);
      const edges = graph.edges
        .filter((edge) => edge.kind === "auto-import" && rel(edge.from)?.startsWith("lib/"))
        .map((edge) => [rel(edge.from), rel(edge.to), edge.autoImportBundle]);
      expect(edges).toEqual([
        ["lib/app-value.ts", "lib/shared.ts", "nitro"],
        ["lib/shared.ts", "lib/app-value.ts", "nuxt"],
      ]);
      expect(graph.cycles).toEqual([]);
      expect(cycles).toEqual([]);
      expect(summary?.cycles).toBe(0);
    },
    {
      appImports: { useShared: "lib/shared.ts", useValue: "lib/app-value.ts" },
      extraImportDirs: ["lib/shared.ts"],
    },
  ));

test("a changed Nitro edge reports its loop even when Nuxt already cycles over the same files", () =>
  withNitroManifest(
    {
      "app/app.vue": "<script setup>useShared()</script>",
      "lib/a.ts": "export const useShared = () => useAppB()\n",
      "lib/b.ts": "import './a'; export const useNitroB = () => 1\n",
      "server/api/shared.ts": "export { useShared as default } from '../../lib/a'",
      "server/utils/a.ts": "export const useA = () => 1",
      "server/utils/b.ts": "export const useB = () => 2",
    },
    async (root) => {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init");
      git("add", "lib", "app", "server", "package.json");
      git(
        "-c",
        "user.name=Doctor",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-m",
        "fixture",
      );
      writeFileSync(
        join(root, "lib/a.ts"),
        "export const useShared = () => useAppB()\nuseNitroB()\n",
      );
      const { diagnostics } = await runViteDoctor({
        root,
        framework: "nuxt",
        analyses: "graph",
        cache: false,
        since: "HEAD",
      });
      const cycles = diagnostics.filter((item) => item.code === "DOC0001");
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.related?.[0]).toMatchObject({
        message: "uses auto-imported `useNitroB` → lib/b.ts",
        range: { line: 2 },
      });
    },
    {
      appImports: { useShared: "lib/a.ts", useAppB: { name: "useNitroB", file: "lib/b.ts" } },
      extraImportDirs: ["lib/b.ts"],
    },
  ));

test("Git scope and the baseline retain a Nitro cycle with the same displayed loop as Nuxt", () =>
  withNitroManifest(
    {
      "app/app.vue": "<script setup>useAppA()</script>",
      "lib/a.ts": "import './b'; import './c'; export const useShared = () => 1",
      "lib/b.ts": "import './a'",
      "lib/c.ts": "useAppA()\n",
      "server/utils/a.ts": "export const useA = () => 1",
      "server/utils/b.ts": "export const useB = () => 1",
      "server/api/shared.ts": "export { useShared as default } from '../../lib/a'",
    },
    async (root) => {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init");
      git("add", "lib", "app", "server", "package.json");
      git(
        "-c",
        "user.name=Doctor",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-m",
        "fixture",
      );
      const options = {
        root,
        framework: "nuxt",
        analyses: "graph",
        rules: cycleRule,
        baseline: "doctor-baseline.json",
        cache: false,
      } as const;
      const before = await runViteDoctor({ ...options, updateBaseline: true });
      const appCycle = before.diagnostics.find((item) => item.message.includes("group of 3 files"));
      expect(appCycle?.message).toContain("lib/a.ts → lib/b.ts → lib/a.ts");
      writeFixture(root, { "lib/c.ts": "useAppA()\nuseShared()\n" });
      for (const filters of [
        { since: "HEAD" },
        { newOnly: true },
        { since: "HEAD", newOnly: true },
      ]) {
        const { diagnostics } = await runViteDoctor({ ...options, ...filters });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.message).toBe(appCycle?.message);
        expect(diagnostics[0]?.fingerprint).not.toBe(appCycle?.fingerprint);
      }
    },
    {
      appImports: { useAppA: { name: "useShared", file: "lib/a.ts" } },
      extraImportDirs: ["lib/a.ts"],
    },
  ));

test("reordering written imports does not make a mixed cycle new to the baseline", () =>
  withNitroManifest(
    {
      "app/app.vue": "<script setup>import './a'</script>",
      "app/a.ts": "import './b'; import './c'; export const useA = () => 1",
      "app/b.ts": "import './a'",
      "app/c.ts": "useA()",
      "server/utils/a.ts": "export const useA = () => 1",
      "server/utils/b.ts": "export const useB = () => 1",
    },
    async (root) => {
      const options = {
        root,
        framework: "nuxt",
        analyses: "graph",
        rules: cycleRule,
        baseline: "doctor-baseline.json",
        cache: false,
      } as const;
      const first = await runViteDoctor({ ...options, updateBaseline: true });
      expect(first.diagnostics).toHaveLength(1);
      expect(first.diagnostics[0]?.message).toContain("app/a.ts → app/b.ts → app/a.ts");
      writeFixture(root, {
        "app/a.ts": "import './c'; import './b'; export const useA = () => 1",
      });
      const second = await runViteDoctor({ ...options, newOnly: true });
      expect(second.diagnostics).toHaveLength(0);
      expect(second.suppressedDiagnostics?.[0]?.message).toContain(
        "app/a.ts → app/c.ts → app/a.ts",
      );
    },
    { appImports: { useA: "app/a.ts" } },
  ));

test.each([false, true])(
  "old production module membership does not prove current HMR (explicit: %s)",
  (explicit) =>
    withNitroManifest(
      {
        "app/app.vue": "<script setup>useLoop()</script>",
        "app/plugins/entry.server.ts": "export default () => useLoop()",
        "app/composables/loop.ts": `${explicit ? "import { useHelper } from './helper';" : ""} export const useLoop = () => useHelper(); if (import.meta.hot) import.meta.hot.accept()`,
        "app/composables/helper.ts":
          "import { useLoop } from './loop'; export const useHelper = () => useLoop()",
      },
      async (root) => {
        const manifestPath = join(root, ".nuxt/doctor.manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.clientBuildFiles = [
          "app/app.vue",
          "app/composables/loop.ts",
          "app/composables/helper.ts",
        ].map((file) => join(root, file));
        writeFileSync(manifestPath, JSON.stringify(manifest));
        writeFixture(root, { "app/app.vue": "<template><div /></template>" });
        const { diagnostics } = await runViteDoctor({
          root,
          framework: "nuxt",
          config: { extends: ["auto", "vite/strict"] },
          cache: false,
        });
        const hmr = diagnostics.filter((item) => item.code === "VITE0029");
        expect(hmr).toHaveLength(1);
        expect(hmr[0]?.message).toContain(
          "does not establish that this whole loop runs in the browser",
        );
      },
      {
        appImports: { useLoop: "app/composables/loop.ts", useHelper: "app/composables/helper.ts" },
        appPlugins: [{ file: "app/plugins/entry.server.ts", mode: "server" }],
      },
    ),
);

test.each([
  { registered: true, explicit: false },
  { registered: true, explicit: true },
  { registered: false, explicit: false },
  { registered: false, explicit: true },
])(
  "Nuxt middleware HMR with registration $registered and explicit import $explicit",
  ({ registered, explicit }) =>
    withNitroManifest(
      {
        "app/middleware/probe.global.ts": `${explicit ? "import { useLoop } from '../composables/loop';" : ""} export default () => useLoop()`,
        "app/composables/loop.ts":
          "import '../middleware/probe.global'; export const useLoop = () => 1; if (import.meta.hot) import.meta.hot.accept()",
      },
      async (root) => {
        const { diagnostics } = await runViteDoctor({
          root,
          framework: "nuxt",
          config: { extends: ["auto", "vite/strict"] },
          cache: false,
        });
        const hmr = diagnostics.filter((item) => item.code === "VITE0029");
        expect(hmr).toHaveLength(1);
        expect(hmr[0]?.message).toContain("app/middleware/probe.global.ts");
        expect(hmr[0]?.message).toContain(
          "does not establish that this whole loop runs in the browser",
        );
      },
      {
        appImports: { useLoop: "app/composables/loop.ts" },
        appMiddleware: registered ? ["app/middleware/probe.global.ts"] : undefined,
      },
    ),
);

test.each([
  { mode: "server", explicit: false },
  { mode: "server", explicit: true },
  { mode: "all", explicit: false },
] as const)(
  "Nuxt HMR stays conditional for $mode plugin registration with explicit import: $explicit",
  ({ mode, explicit }) =>
    withNitroManifest(
      {
        "app/app.vue": "<template><div /></template>",
        "app/plugins/entry.ts": "import '../../lib/helper'; export default () => {}",
        "lib/helper.ts": `${explicit ? "import { useLoop } from '../app/composables/useLoop';" : ""} useLoop(); if (import.meta.hot) import.meta.hot.accept()`,
        "app/composables/useLoop.ts": "import '../plugins/entry'; export const useLoop = () => 1",
      },
      async (root) => {
        const { cycles, graph } = await analyze(root);
        expect(cycles.some((cycle) => cycle.message.includes("lib/helper.ts"))).toBe(true);
        expect(
          graph.edges.find((edge) => edge.to?.endsWith("/app/plugins/entry.ts"))?.clientReachable,
        ).toBeUndefined();
        const { diagnostics } = await runViteDoctor({
          root,
          framework: "nuxt",
          config: { extends: ["auto", "vite/strict"] },
          cache: false,
        });
        const hmr = diagnostics.filter((item) => item.code === "VITE0029");
        expect(hmr).toHaveLength(1);
        expect(hmr[0]?.message).toContain(
          "does not establish that this whole loop runs in the browser",
        );
      },
      {
        appImports: { useLoop: "app/composables/useLoop.ts" },
        appPlugins: [{ file: "app/plugins/entry.ts", mode }],
      },
    ),
);

test.each([false, true])(
  "Nuxt HMR keeps a router-options plugin loop conditional (explicit: %s)",
  (explicit) =>
    withNitroManifest(
      {
        "app/app.vue": "<template><NuxtPage /></template>",
        "app/pages/index.vue": "<template><div /></template>",
        "app/router.options.ts":
          "import { scrollBehavior } from './plugins/entry.server'; export default { scrollBehavior }",
        "app/plugins/entry.server.ts":
          "import { getPosition } from '../helper'; export const scrollBehavior = () => getPosition(); export default () => {}",
        "app/helper.ts": `${explicit ? "import { scrollBehavior } from './plugins/entry.server';" : ""} export const getPosition = () => ({ top: 0 }); export const reset = () => scrollBehavior(); if (import.meta.hot) import.meta.hot.accept()`,
      },
      async (root) => {
        const { cycles } = await analyze(root);
        expect(cycles.some((cycle) => cycle.message.includes("app/plugins/entry.server.ts"))).toBe(
          true,
        );
        const { diagnostics } = await runViteDoctor({
          root,
          framework: "nuxt",
          config: { extends: ["auto", "vite/strict"] },
          cache: false,
        });
        const hmr = diagnostics.filter((item) => item.code === "VITE0029");
        expect(hmr).toHaveLength(1);
        expect(hmr[0]?.message).toContain("app/plugins/entry.server.ts");
        expect(hmr[0]?.message).toContain(
          "does not establish that this whole loop runs in the browser",
        );
      },
      {
        appImports: { scrollBehavior: "app/plugins/entry.server.ts" },
        appPlugins: [{ file: "app/plugins/entry.server.ts", mode: "server" }],
      },
    ),
);

test.each([false, true])("Nuxt HMR sees the loop with an explicit import: %s", (explicit) =>
  withNitroManifest(
    {
      "app/app.vue": `<script setup>${explicit ? "import { useLoop } from './utils/loop';" : ""} useLoop()</script>`,
      "app/utils/loop.ts": "import App from '../app.vue'; export const useLoop = () => App",
      "server/utils/a.ts": "export const useA = () => useB(); import.meta.hot.accept()",
    },
    async (root) => {
      const { diagnostics } = await runViteDoctor({
        root,
        framework: "nuxt",
        config: { extends: ["auto", "vite/strict"] },
        cache: false,
      });
      const hmr = diagnostics.filter((item) => item.code === "VITE0029");
      expect(hmr).toHaveLength(1);
      expect(hmr[0]?.message).toContain("app/utils/loop.ts → app/app.vue → app/utils/loop.ts");
    },
    { appImports: { useLoop: "app/utils/loop.ts" } },
  ),
);

test("Nitro's custom resolver withholds unproven injection targets even in trusted runs", () =>
  withNitroManifest(
    { "server/lib/replacement.ts": "export const useB = () => 1" },
    async (root) => {
      const { autoImportEdges, cycles, gaps } = await analyze(root, true);
      expect(autoImportEdges).toEqual([]);
      expect(cycles).toEqual([]);
      expect(gaps).toEqual([expect.stringContaining("custom auto-import resolver")]);
    },
    {
      imports: { resolveId: (from: string) => from.replace("/utils/b.ts", "/lib/replacement.ts") },
    },
  ));

test.each([
  { name: "exclude", imports: { exclude: /\/utils\/b\.ts$/ }, source: useB },
  { name: "relative exclude", imports: { exclude: "server/utils/b.ts" }, source: useB },
  { name: "include", imports: { include: "**/utils/a.ts" }, source: useB },
  { name: "default opt-out", imports: {}, source: `/*! @unimport-disable */\n${useB}` },
  {
    name: "configured opt-out",
    imports: { commentsDisable: ["@no-inject"] },
    source: `/*! @no-inject */\n${useB}`,
  },
])("Nitro's $name suppresses injection but not registry membership", ({ imports, source }) =>
  withNitroManifest(
    { "server/utils/b.ts": source },
    async (root) => {
      const { autoImportEdges, cycles } = await analyze(root);
      expect(autoImportEdges).toEqual(["server/utils/a.ts -useB-> server/utils/b.ts"]);
      expect(cycles).toEqual([]);
    },
    { imports, relativeTransformPaths: true },
  ),
);

test("adding an export to an existing Nitro scan input invalidates the captured registry", () =>
  withNitroManifest(
    { "server/utils/b.ts": "export const other = 1\n" },
    async (root, rewriteManifest) => {
      expect((await analyze(root)).gaps).toEqual([]);
      writeFixture(root, { "server/utils/b.ts": `export const other = 1\n${useB}` });
      await rewriteManifest();
      const { autoImportEdges, cycles, gaps } = await analyze(root);
      expect(autoImportEdges).toEqual([]);
      expect(cycles).toEqual([]);
      expect(gaps).toEqual([expect.stringContaining("Nitro's auto-import scan inputs changed")]);
    },
  ));

test("Nitro's cached registry cannot certify files edited by an earlier init hook", () =>
  withNitroManifest(
    { "server/utils/b.ts": "export const other = 1\n" },
    async (root) => {
      const { autoImportEdges, gaps } = await analyze(root);
      expect(autoImportEdges).toEqual([]);
      expect(gaps).toEqual([expect.stringContaining("Nitro's auto-import scan")]);
    },
    {
      afterInit: (root) =>
        writeFixture(root, { "server/utils/b.ts": `export const other = 1\n${useB}` }),
    },
  ));

test.each(["star re-exports", "symlinked directories"])("Nitro scan evidence follows %s", (kind) =>
  withNitroManifest(
    {
      "server/utils/b.ts": "export const other = 1\n",
      "server/lib/b.ts": "export const yetAnother = 2\n",
      ...(kind === "star re-exports"
        ? { "server/utils/barrel.ts": 'export * from "../lib/b"\n' }
        : {}),
    },
    async (root) => {
      expect((await analyze(root)).gaps).toEqual([]);
      writeFixture(root, { "server/lib/b.ts": `export const yetAnother = 2\n${useB}` });
      const { autoImportEdges, gaps } = await analyze(root);
      expect(autoImportEdges).toEqual([]);
      expect(gaps).toEqual([expect.stringContaining("Nitro's auto-import scan inputs changed")]);
    },
    {
      beforeInit: (root) => {
        if (kind === "symlinked directories")
          symlinkSync(join(root, "server/lib"), join(root, "server/utils/linked"), "junction");
      },
    },
  ),
);

test("editing a file excluded by Nitro's scan filter does not invalidate the cycle", () =>
  withNitroManifest(
    { "server/utils/helper.test.ts": "export const helper = 1\n" },
    async (root, rewriteManifest) => {
      writeFixture(root, { "server/utils/helper.test.ts": "export const helper = 2\n" });
      const { cycles, gaps } = await analyze(root);
      expect(cycles).toHaveLength(1);
      expect(gaps).toEqual([]);
      writeFixture(root, { "server/utils/new.ts": "export const newUtil = 1\n" });
      await rewriteManifest();
      expect((await analyze(root)).gaps).toEqual([
        expect.stringContaining("Nitro's auto-import scan inputs changed"),
      ]);
    },
    { imports: { dirsScanOptions: { fileFilter: (file: string) => !file.endsWith(".test.ts") } } },
  ));
