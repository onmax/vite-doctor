import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  createRule,
  defineDoctorExtension,
  defineRulePack,
  type ImportGraph,
} from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";

const cycleRule = "workspace/dead-code/circular-dependency";

const useA = "export function useA() {\n  return useB() + 1\n}\n";
const useB = "export function useB(n = 0) {\n  return n > 0 ? useA() : 0\n}\n";

async function run(files: Record<string, string>, { manifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-auto-import-edges-"));
  let captured: ImportGraph | undefined;
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
          captured = await ctx.inventory.importGraph();
        },
      };
    },
  });
  try {
    const fixture: Record<string, string> = {
      "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.4.6" } }),
      ...files,
    };
    if (manifest)
      fixture[".nuxt/doctor.manifest.json"] = JSON.stringify({
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
          { name: "useFetch", from: "#app/composables/fetch", kind: "nuxt" },
          { name: "useA", from: join(root, "app/composables/useA.ts"), kind: "app" },
          { name: "useB", from: join(root, "app/composables/useB.ts"), kind: "app" },
          { name: "formatPrice", from: "~/utils/format", kind: "app" },
        ],
        components: [],
        layers: [{ root, priority: 0 }],
        routeRules: {},
        serverHandlers: [],
        modules: [],
        moduleSources: [],
      });
    for (const [file, text] of Object.entries(fixture)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const result = await runViteDoctor({
      root,
      framework: "nuxt",
      analyses: "graph,dead-code",
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
    "app/composables/useB.ts": `${declaration}\n`,
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
