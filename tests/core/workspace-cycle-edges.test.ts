import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import { createRule, type DoctorRule, type ImportGraph } from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { runRuleFixture } from "../../src/testkit.ts";

const cycleRule = "workspace/dead-code/circular-dependency";

async function cycles(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-cycle-edges-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const result = await runViteDoctor({
      root,
      framework: "vite",
      analyses: "graph",
      cache: false,
    });
    return result.diagnostics
      .filter((item) => item.ruleId === cycleRule)
      .map((item) => ({
        file: relative(root, item.file),
        range: item.range,
        message: item.message,
        fingerprint: item.fingerprint,
        related: item.related?.map((entry) => ({
          file: relative(root, entry.file),
          line: entry.range?.line,
          start: entry.range?.start,
          message: entry.message,
        })),
      }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const triangle = {
  "src/a.ts": 'import { b } from "./b";\nexport const a = () => b;\n',
  "src/b.ts": 'export const before = 1;\nimport { c } from "./c";\nexport const b = () => c;\n',
  "src/c.ts": 'import { a } from "./a";\nexport const c = () => a;\n',
};

test("reports each import edge of the cycle with its range", async () => {
  const [diagnostic, ...rest] = await cycles(triangle);
  expect(rest).toEqual([]);
  expect(diagnostic).toMatchObject({
    file: "src/a.ts",
    range: { line: 1, start: 0 },
    message: "Circular import: src/a.ts → src/b.ts → src/c.ts → src/a.ts.",
    related: [
      { file: "src/a.ts", line: 1, start: 0, message: "imports './b' → src/b.ts" },
      { file: "src/b.ts", line: 2, start: 25, message: "imports './c' → src/c.ts" },
      { file: "src/c.ts", line: 1, start: 0, message: "imports './a' → src/a.ts" },
    ],
  });
});

test("an acyclic chain reports nothing", async () => {
  expect(await cycles({ ...triangle, "src/c.ts": "export const c = () => 1;\n" })).toEqual([]);
});

test.each([
  'import type { A } from "./a";\nexport const c = 1;\n',
  'export type { A } from "./a";\nexport const c = 1;\n',
])("a type-only back edge does not close a runtime cycle: %s", async (c) => {
  expect(
    await cycles({
      ...triangle,
      "src/a.ts": 'import { b } from "./b";\nexport type A = string;\nexport const a = b;\n',
      "src/c.ts": c,
    }),
  ).toEqual([]);
});

test("the path skips a type-only edge and keeps group members off the path", async () => {
  const [diagnostic] = await cycles({
    "src/a.ts": 'import type { C } from "./c";\nimport { b } from "./b";\nexport const a = b;\n',
    "src/b.ts": 'import { a } from "./a";\nimport { c } from "./c";\nexport const b = a;\n',
    "src/c.ts": 'import { b } from "./b";\nexport type C = string;\nexport const c = b;\n',
  });
  expect(diagnostic).toMatchObject({
    file: "src/a.ts",
    range: { line: 2 },
    message:
      "Circular import: src/a.ts → src/b.ts → src/a.ts. It is one loop in a group of 3 files that import each other; the file off this loop is listed as a cycle member.",
    related: [
      { file: "src/a.ts", line: 2, message: "imports './b' → src/b.ts" },
      { file: "src/b.ts", line: 1, message: "imports './a' → src/a.ts" },
      { file: "src/c.ts", message: "Cycle member" },
    ],
  });
});

test("the fingerprint follows the cycle members, not import order", async () => {
  const [first] = await cycles(triangle);
  const [reordered] = await cycles({
    ...triangle,
    "src/a.ts": 'export const before = 1;\n\nimport { b } from "./b";\nexport const a = () => b;\n',
  });
  expect(reordered!.related![0]!.line).toBe(3);
  expect(reordered!.fingerprint).toBe(first!.fingerprint);
});

function captureImportGraph(): { rule: DoctorRule; graph: () => ImportGraph } {
  let captured: ImportGraph | undefined;
  const rule = createRule({
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
  return {
    rule,
    graph: () => {
      if (!captured) throw new Error("The capture Rule did not run.");
      return captured;
    },
  };
}

test("Rules read files, edges, importers, and cycles from ctx.inventory.importGraph()", async () => {
  const { rule, graph } = captureImportGraph();
  const result = await runRuleFixture({
    rule,
    files: {
      ...triangle,
      "src/d.ts": [
        'import type { A } from "./a";',
        'export { b, before } from "./b";',
        'export const load = () => import("./c");',
        'import "missing-package";',
      ].join("\n"),
    },
  });
  const root = result.root;
  const rel = (file?: string) => file && relative(root, file);
  const imports = graph();

  expect(imports.files.map(rel)).toEqual(
    expect.arrayContaining(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]),
  );
  expect(
    imports
      .importsOf("src/d.ts")
      .map((edge) => [rel(edge.to), edge.specifier, edge.kind, edge.typeOnly, edge.range?.line]),
  ).toEqual([
    ["src/a.ts", "./a", "import", true, 1],
    [undefined, "missing-package", "import", false, 4],
    ["src/b.ts", "./b", "re-export", false, 2],
    ["src/c.ts", "./c", "dynamic-import", false, 3],
  ]);
  expect(imports.importsOf(join(root, "src/d.ts"))).toEqual(imports.importsOf("src/d.ts"));
  expect(imports.importersOf("src/a.ts").map((edge) => rel(edge.from))).toEqual([
    "src/c.ts",
    "src/d.ts",
  ]);
  expect(imports.edges).toHaveLength(7);
  expect(
    imports.cycles.map((cycle) => ({
      files: cycle.files.map(rel),
      path: cycle.path.map((edge) => `${rel(edge.from)} -> ${rel(edge.to)}`),
    })),
  ).toEqual([
    {
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      path: ["src/a.ts -> src/b.ts", "src/b.ts -> src/c.ts", "src/c.ts -> src/a.ts"],
    },
  ]);
});

test("file Rules cannot read the import graph", async () => {
  const rule = createRule({
    meta: {
      id: "test/file-import-graph",
      title: "File",
      category: "architecture",
      severity: "info",
    },
    async create(ctx) {
      await ctx.inventory.importGraph();
    },
  });
  await expect(
    runRuleFixture({ rule, files: { "src/a.ts": "export const a = 1" } }),
  ).rejects.toThrow(/set meta\.execution to "workspace"/);
});
