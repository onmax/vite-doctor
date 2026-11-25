import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import { createUnimport, type Import } from "unimport";
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

interface RunOptions {
  manifest?: boolean;
  analyses?: string;
  autoImports?: (root: string) => Import[];
  rawCandidates?: boolean;
  layers?: (root: string) => unknown[];
  concurrent?: boolean;
}

function manifestFor(root: string, options: RunOptions) {
  const entries = [
    { name: "ref", from: "vue", kind: "vue" },
    { name: "useFetch", from: "#app/composables/fetch", kind: "nuxt" },
    { name: "useA", from: join(root, "app/composables/useA.ts"), kind: "app" },
    { name: "useB", from: join(root, "app/composables/useB.ts"), kind: "app" },
    { name: "formatPrice", from: "~/utils/format", kind: "app" },
    ...(options.autoImports?.(root) ?? []),
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
    autoImports: entries,
    runtimeAutoImports: entries.filter((entry) => !("type" in entry && entry.type)),
    components: [],
    layers: options.layers?.(root) ?? [{ root, priority: 0 }],
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

async function run(files: Record<string, string>, options: RunOptions = {}) {
  const { manifest = true, concurrent = false } = options;
  const root = mkdtempSync(join(tmpdir(), "doctor-auto-import-edges-"));
  let captured: ImportGraph | undefined;
  let capturedTwice: ImportGraph | undefined;
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
          if (concurrent)
            [captured, capturedTwice] = await Promise.all([
              ctx.inventory.importGraph(),
              ctx.inventory.importGraph(),
            ]);
          else captured = await ctx.inventory.importGraph();
        },
      };
    },
  });
  try {
    const fixture: Record<string, string> = {
      "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.4.6" } }),
      ...files,
    };
    if (manifest && !options.rawCandidates)
      fixture[".nuxt/doctor.manifest.json"] = manifestFor(root, options);
    writeFixture(root, fixture);
    if (options.rawCandidates) {
      const imports = JSON.parse(manifestFor(root, options)).autoImports as Import[];
      const context = createUnimport({ imports });
      const hooks = new Map<string, (payload?: any) => unknown>();
      await nuxtDoctorModule({}, {
        _version: "4.4.6",
        options: { rootDir: root, srcDir: join(root, "app"), buildDir: ".nuxt", modules: [] },
        hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
        async callHook() {},
      } as any);
      await hooks.get("imports:context")!(context);
      await hooks.get("imports:extend")!(imports);
      await hooks.get("prepare:types")!();
      const evidence = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(evidence.autoImports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "useB", from: join(root, "app/composables/useB.ts") }),
        ]),
      );
      expect(evidence.runtimeAutoImports).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "useB" })]),
      );
    }
    const result = await runViteDoctor({
      root,
      framework: "nuxt",
      analyses: options.analyses ?? "graph,dead-code",
      rules: "test/import-graph,workspace/dead-code/*",
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
    const rel = (file?: string) => file && relative(root, file);
    if (!captured) throw new Error("The capture Rule did not run.");
    const graph = captured;
    return {
      cycles: result.diagnostics
        .filter((item) => item.ruleId === cycleRule)
        .map((item) => ({
          file: rel(item.file),
          message: item.message,
          related: item.related?.map((entry) => ({
            file: rel(entry.file),
            line: entry.range?.line,
            column: entry.range?.column,
            message: entry.message,
          })),
        })),
      deadCode: result.diagnostics
        .filter((item) =>
          /^workspace\/dead-code\/unused-(file|export|type-export)$/.test(item.ruleId),
        )
        .map((item) => `${item.ruleId} ${rel(item.file)}`),
      autoImportEdges: graph.edges
        .filter((edge) => edge.kind === "auto-import")
        .map((edge) => `${rel(edge.from)} -${edge.specifier}-> ${rel(edge.to)}`),
      graph,
      capturedTwice,
      rel,
      gaps: (result.project.evidenceGaps ?? []).map((gap) => gap.message),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("composables that call each other through auto-imports form a DOC0001 cycle", async () => {
  const { cycles, autoImportEdges, graph, rel } = await run({
    "app/composables/useA.ts": useA,
    "app/composables/useB.ts": useB,
  });
  expect(autoImportEdges).toEqual([
    "app/composables/useA.ts -useB-> app/composables/useB.ts",
    "app/composables/useB.ts -useA-> app/composables/useA.ts",
  ]);
  expect(cycles).toEqual([
    {
      file: "app/composables/useA.ts",
      message:
        "Circular import: app/composables/useA.ts → app/composables/useB.ts → app/composables/useA.ts.",
      related: [
        {
          file: "app/composables/useA.ts",
          line: 2,
          column: 10,
          message: "uses auto-imported `useB` → app/composables/useB.ts",
        },
        {
          file: "app/composables/useB.ts",
          line: 2,
          column: 18,
          message: "uses auto-imported `useA` → app/composables/useA.ts",
        },
      ],
    },
  ]);
  expect(graph.cycles.map((cycle) => cycle.files.map(rel))).toEqual([
    ["app/composables/useA.ts", "app/composables/useB.ts"],
  ]);
  expect(
    graph.importersOf("app/composables/useB.ts").map((edge) => [rel(edge.from), edge.typeOnly]),
  ).toEqual([["app/composables/useA.ts", false]]);
});

test("a one-way auto-import is an edge but not a cycle", async () => {
  const { cycles, autoImportEdges } = await run({
    "app/composables/useA.ts": useA,
    "app/composables/useB.ts": "export function useB() {\n  return 1\n}\n",
  });
  expect(autoImportEdges).toEqual(["app/composables/useA.ts -useB-> app/composables/useB.ts"]);
  expect(cycles).toEqual([]);
});

test("a multiline re-export closes an auto-import cycle and retains its declaration range", async () => {
  const declaration = 'export { useA }\n  from "./useA";';
  const { graph } = await run({
    "app/composables/useA.ts": useA,
    "app/composables/useB.ts": `${declaration}\nexport const useB = () => 1\n`,
  });
  const path = graph.cycles[0]?.path;
  expect(path?.map((edge) => edge.kind)).toEqual(["auto-import", "re-export"]);
  expect(path?.[1]?.range).toMatchObject({ start: 0, end: declaration.length });
});

test("a local binding shadows the auto-import", async () => {
  const { cycles, autoImportEdges } = await run({
    "app/composables/useA.ts": useA,
    "app/composables/useB.ts": [
      "function useA() {\n  return 1\n}",
      "export function useB() {\n  return useA()\n}",
      "export function useC(useB: () => number) {\n  return useB()\n}",
    ].join("\n"),
  });
  expect(autoImportEdges).toEqual(["app/composables/useA.ts -useB-> app/composables/useB.ts"]);
  expect(cycles).toEqual([]);
});

test("explicit imports, package auto-imports, and template expressions add no auto-import edges", async () => {
  const { autoImportEdges } = await run({
    "app/composables/useA.ts": 'import { useB } from "./useB"\nexport const useA = () => useB()\n',
    "app/composables/useB.ts": "export const useB = () => ref(useFetch('/api'))\n",
    "app/pages/index.vue":
      '<script setup lang="ts">\nconst a = useA()\n</script>\n<template>{{ useB() }}</template>\n',
  });
  expect(autoImportEdges).toEqual(["app/pages/index.vue -useA-> app/composables/useA.ts"]);
});

test("an export used only through an auto-import is not reported unused", async () => {
  const { deadCode, autoImportEdges } = await run({
    "app/utils/format.ts": "export const formatPrice = (value: number) => `${value} EUR`\n",
    "app/pages/index.vue":
      '<script setup lang="ts">\nconst prices = [1, 2].map(formatPrice)\n</script>\n<template>{{ prices }}</template>\n',
  });
  expect(autoImportEdges).toEqual(["app/pages/index.vue -formatPrice-> app/utils/format.ts"]);
  expect(deadCode).toEqual([]);
});

test("without a current Nuxt manifest there are no auto-import edges and the gap is reported", async () => {
  const { cycles, autoImportEdges, gaps } = await run(
    { "app/composables/useA.ts": useA, "app/composables/useB.ts": useB },
    { manifest: false },
  );
  expect(autoImportEdges).toEqual([]);
  expect(cycles).toEqual([]);
  expect(gaps).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        ".nuxt/doctor.manifest.json is missing, so Doctor cannot prove which names Nuxt auto-imports from project files",
      ),
    ]),
  );
});

test("a class registered as both a value and a type keeps its runtime auto-import", async () => {
  const { autoImportEdges, deadCode } = await run(
    {
      "app/utils/model.ts": "export class SharedModel {\n  id = 1\n}\n",
      "app/pages/index.vue":
        '<script setup lang="ts">\nconst model = new SharedModel()\n</script>\n<template>{{ model.id }}</template>\n',
    },
    {
      autoImports: (root) => [
        { name: "SharedModel", from: join(root, "app/utils/model.ts") },
        { name: "SharedModel", from: join(root, "app/utils/model.ts"), type: true },
      ],
    },
  );
  expect(autoImportEdges).toEqual(["app/pages/index.vue -SharedModel-> app/utils/model.ts"]);
  expect(deadCode).toEqual([]);
});

test("type queries and write-only targets are not runtime auto-import reads", async () => {
  const { autoImportEdges, cycles } = await run({
    "app/composables/useA.ts":
      "export type B = typeof useB\nexport function useA() {\n  useB = 1\n  return 1\n}\n",
    "app/composables/useB.ts": useB,
  });
  expect(autoImportEdges).toEqual(["app/composables/useB.ts -useA-> app/composables/useA.ts"]);
  expect(cycles).toEqual([]);
});

test("an identifier spelled with a Unicode escape is still an auto-import read", async () => {
  const { autoImportEdges, graph, rel } = await run({
    "app/composables/useB.ts": "export function useB() {\n  return 1\n}\n",
    "app/utils/run.ts": "export const run = () =>\n  use\\u0042()\n",
  });
  expect(autoImportEdges).toEqual(["app/utils/run.ts -useB-> app/composables/useB.ts"]);
  const [edge] = graph.importsOf(graph.files.find((file) => rel(file) === "app/utils/run.ts")!);
  expect(edge?.range).toMatchObject({ line: 2, column: 3 });
  expect(edge!.range!.end - edge!.range!.start).toBe("use\\u0042".length);
});

test("a <script setup> local does not shadow an auto-import in the normal <script>", async () => {
  const { autoImportEdges } = await run({
    "app/composables/useB.ts": "export function useB() {\n  return 1\n}\n",
    "app/components/Widget.vue": [
      '<script lang="ts">',
      "export const makeValue = () => useB()",
      "</script>",
      '<script setup lang="ts">',
      "const useB = () => 42",
      "const value = useB()",
      "</script>",
      "<template>{{ value }}</template>",
      "",
    ].join("\n"),
    "app/pages/index.vue": [
      '<script lang="ts">',
      'import { useB as local } from "~/composables/useB"',
      "export const makeValue = () => local()",
      "</script>",
      '<script setup lang="ts">',
      'import { useA } from "~/composables/useA"',
      "const value = useA()",
      "</script>",
      "<template>{{ value }}</template>",
      "",
    ].join("\n"),
    "app/composables/useA.ts": "export const useA = () => 1\n",
  });
  expect(autoImportEdges).toEqual(["app/components/Widget.vue -useB-> app/composables/useB.ts"]);
});

test("an export removed after the manifest was generated withholds the edges and reports the gap", async () => {
  const { autoImportEdges, cycles, gaps } = await run({
    "app/composables/useA.ts": useA,
    "app/composables/useB.ts": "export function useRenamed() {\n  return useA()\n}\n",
  });
  expect(autoImportEdges).toEqual([]);
  expect(cycles).toEqual([]);
  expect(gaps).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "lists `useB` from app/composables/useB.ts, which no longer exports it",
      ),
    ]),
  );
});

test.each(["export enum Mode { Ready }", "export const { Mode } = { Mode: 1 }"])(
  "a fresh registry accepts %s without suppressing an unrelated cycle",
  async (source) => {
    const { cycles, gaps } = await run(
      {
        "app/composables/useA.ts": useA,
        "app/composables/useB.ts": useB,
        "app/utils/mode.ts": source,
      },
      { autoImports: (root) => [{ name: "Mode", from: join(root, "app/utils/mode.ts") }] },
    );
    expect(cycles).toHaveLength(1);
    expect(gaps).toEqual([]);
  },
);

test("a winning type-only candidate does not revive a discarded runtime binding", async () => {
  const { autoImportEdges, cycles } = await run(
    {
      "app/composables/useA.ts": useA,
      "app/composables/useB.ts": useB,
      "app/types.ts": "export type B = number",
    },
    {
      rawCandidates: true,
      autoImports: (root) => [
        { name: "B", as: "useB", from: join(root, "app/types.ts"), type: true, priority: 2 },
      ],
    },
  );
  expect(autoImportEdges).toEqual(["app/composables/useB.ts -useA-> app/composables/useA.ts"]);
  expect(cycles).toEqual([]);
});

test("files in a layer's configured serverDir get no app auto-import edges", async () => {
  const { autoImportEdges } = await run(
    {
      "app/composables/useB.ts": "export function useB() {\n  return 1\n}\n",
      "backend/utils/useB.ts": "export function useB() {\n  return 2\n}\n",
      "backend/api/test.ts": "export default () => useB()\n",
      "app/pages/index.vue":
        '<script setup lang="ts">\nconst value = useB()\n</script>\n<template>{{ value }}</template>\n',
    },
    { layers: (root) => [{ root, priority: 0, serverDir: join(root, "backend") }] },
  );
  expect(autoImportEdges).toEqual(["app/pages/index.vue -useB-> app/composables/useB.ts"]);
});

test("an auto-import keeps only its resolved destination live, not other exports of the name", async () => {
  const { autoImportEdges, deadCode } = await run({
    "app/composables/useB.ts": "export function useB() {\n  return 1\n}\n",
    "app/legacy/old.ts": "export const useB = () => 2\n",
    "app/pages/index.vue":
      '<script setup lang="ts">\nconst values = [1].map(useB)\n</script>\n<template>{{ values }}</template>\n',
  });
  expect(autoImportEdges).toEqual(["app/pages/index.vue -useB-> app/composables/useB.ts"]);
  expect(deadCode).toEqual([
    "workspace/dead-code/unused-file app/legacy/old.ts",
    "workspace/dead-code/unused-export app/legacy/old.ts",
  ]);
});

test("concurrent import graph requests all see the completed auto-import edges", async () => {
  const { graph, capturedTwice } = await run(
    {
      "app/components/Counter.vue":
        '<script setup lang="ts">\nconst value = useA()\n</script>\n<template>{{ value }}</template>\n',
      "app/composables/useA.ts": useA,
      "app/composables/useB.ts": useB,
    },
    { analyses: "", concurrent: true },
  );
  expect(graph.cycles).toHaveLength(1);
  expect(capturedTwice?.cycles).toHaveLength(1);
});

test("the default run's graph summary does not depend on an earlier cached graph analysis", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-auto-import-edges-cache-"));
  try {
    writeFixture(root, {
      "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.4.6" } }),
      ".nuxt/doctor.manifest.json": manifestFor(root, {}),
      "app/composables/useA.ts": useA,
      "app/composables/useB.ts": useB,
    });
    const options = { root, framework: "nuxt" as const, cache: true };
    const cold = await runViteDoctor(options);
    rmSync(join(root, ".vite-doctor"), { recursive: true, force: true });
    await runViteDoctor({ ...options, analyses: "graph" });
    const afterGraph = await runViteDoctor(options);
    expect(afterGraph.graph).toEqual(cold.graph);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
