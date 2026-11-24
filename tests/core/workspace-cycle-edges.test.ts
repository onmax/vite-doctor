import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import { createRule, type DoctorRule, type ImportGraph } from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { runRuleFixture } from "../../src/testkit.ts";

const cycleRule = "workspace/dead-code/circular-dependency";

async function cycles(files: Record<string, string>, edits?: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-cycle-edges-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    if (edits) {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init");
      git("add", ".");
      git(
        "-c",
        "user.name=Doctor",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-m",
        "fixture",
      );
      for (const [file, text] of Object.entries(edits)) writeFileSync(join(root, file), text);
    }
    const result = await runViteDoctor({
      root,
      framework: "vite",
      analyses: "graph",
      cache: false,
      ...(edits && { since: "HEAD" }),
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
    ["src/b.ts", "./b", "re-export", false, 2],
    ["src/c.ts", "./c", "dynamic-import", false, 3],
    [undefined, "missing-package", "import", false, 4],
  ]);
  expect(
    imports.edges.filter((edge) => rel(edge.from) === "src/d.ts").map((edge) => edge.range?.line),
  ).toEqual([1, 2, 3, 4]);
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

test("each source-bearing re-export declaration has its own edge", async () => {
  const { rule, graph } = captureImportGraph();
  const source = [
    'export { x } from "./b";',
    'export { y } from "./b";',
    'export {} from "./b";',
    'export type { T } from "./b";',
    'export * as other from "./b";',
  ];
  await runRuleFixture({
    rule,
    files: {
      "src/a.ts": source.join("\n"),
      "src/b.ts": "export const x = 1, y = 2; export type T = string;",
    },
  });
  expect(
    graph()
      .importsOf("src/a.ts")
      .map((edge) => [
        edge.kind,
        edge.specifier,
        edge.typeOnly,
        source.join("\n").slice(edge.range?.start, edge.range?.end),
      ]),
  ).toEqual(source.map((statement, index) => ["re-export", "./b", index === 3, statement]));
});

test("a changed module specifier in a multiline re-export qualifies the cycle", async () => {
  const files = {
    "src/a.ts": 'export { x }\n  from "./c";\n',
    "src/b.ts": 'import "./a";\nexport const x = 1;\n',
    "src/c.ts": "export const x = 1;\n",
  };
  const edits = { "src/a.ts": 'export { x }\n  from "./b";\n' };
  expect(await cycles({ ...files, ...edits })).toHaveLength(1);
  expect(await cycles(files, edits)).toHaveLength(1);
});

test("an empty re-export can close a runtime cycle", async () => {
  expect(
    await cycles({
      "src/a.ts": 'export {} from "./b";\n',
      "src/b.ts": 'import "./a";\n',
    }),
  ).toHaveLength(1);
});

test("parallel declarations preserve both edges and use the earliest one in the loop", async () => {
  const { rule, graph } = captureImportGraph();
  await runRuleFixture({
    rule,
    files: {
      "src/a.ts": 'import "./b";\nexport {} from "./b";',
      "src/b.ts": 'import "./a";',
    },
  });
  const imports = graph();
  const declarations = imports.importsOf("src/a.ts");
  expect(declarations.map((edge) => edge.kind)).toEqual(["import", "re-export"]);
  expect(imports.cycles[0]?.path).toHaveLength(2);
  expect(imports.cycles[0]?.path[0]).toBe(declarations[0]);
});

test("a change to a runtime edge off the loop qualifies the cycle, but an unrelated edit does not", async () => {
  const files = {
    "src/a.ts": 'import "./b";\n',
    "src/b.ts": 'import "./a";\nimport "./c";\n',
    "src/c.ts": "export const c = 1;\n",
  };
  const edits = { "src/c.ts": 'import "./b";\nexport const c = 1;\n' };
  const [diagnostic] = await cycles(files, edits);
  expect(diagnostic?.message).toContain("src/a.ts → src/b.ts → src/a.ts");
  expect(
    await cycles(
      { ...files, ...edits },
      {
        "src/c.ts": 'import "./b";\nexport const c = 2;\n',
      },
    ),
  ).toEqual([]);
});

test("the shortest loop can start late in a large group", async () => {
  const module = (index: number) => `n${String(index).padStart(3, "0")}`;
  const files = Object.fromEntries(
    Array.from({ length: 202 }, (_, index) => [
      `src/${module(index)}.js`,
      `import "./${module((index + 1) % 202)}";\n${index === 201 ? 'import "./n200";\n' : ""}`,
    ]),
  );
  const [diagnostic] = await cycles(files);
  expect(diagnostic?.message).toMatch(
    /^Circular import: src\/n200\.js → src\/n201\.js → src\/n200\.js\./,
  );
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
  ).rejects.toThrow(/must use workspace execution or declare uncached cross-file execution/);
});
