import { expect, test, vi } from "vite-plus/test";
import type { RuleVisitor, SourceFileHandle } from "../../src/core/primitives.ts";
import { runVisitor, runVisitors } from "../../src/core/internal/rule-runner.ts";
import { parseSfcFile } from "../../src/core/internal/sfc.ts";
import { parseScript } from "../../src/core/internal/script.ts";

function createFile(): SourceFileHandle {
  return {
    path: "/app.vue",
    relativePath: "app.vue",
    sourceKind: "app",
    text: "",
    hash: "fixture",
    isVueSfc: true,
    scriptAst: { type: "Program", body: [] },
    templateAst: { type: "VDocumentFragment", children: [] },
    project: {
      root: "/",
      framework: "vue",
      ssr: false,
      vueVersion: "3.5.0",
      isMonorepo: false,
    },
    matches: () => true,
    inAppDir: () => false,
    isModuleSource: () => false,
  };
}

test.each<keyof RuleVisitor>(["SFC", "onProjectStart", "TemplateNode"])(
  "%s visitors do not traverse the script AST",
  async (hook) => {
    const file = createFile();
    file.sfc = await parseSfcFile(file.path, "<template><div /></template>");
    const body = vi.fn(() => []);
    Object.defineProperty(file.scriptAst, "body", { get: body, enumerable: true });
    const callback = vi.fn();

    await runVisitor({ [hook]: callback }, file);

    expect(body).not.toHaveBeenCalled();
    if (hook !== "onProjectStart") expect(callback).toHaveBeenCalledOnce();
  },
);

test.each<keyof RuleVisitor>(["SFC", "onProjectStart", "ScriptNode", "ImportDeclaration"])(
  "%s visitors do not traverse the template AST",
  async (hook) => {
    const file = createFile();
    const children = vi.fn(() => []);
    Object.defineProperty(file.templateAst, "children", { get: children, enumerable: true });

    await runVisitor({ [hook]: vi.fn() }, file);

    expect(children).not.toHaveBeenCalled();
  },
);

test("import-only visitors receive imports with script parent links", async () => {
  const file = createFile();
  file.scriptAst = parseScript("app.ts", 'import { ref } from "vue"; const count = ref(0)');
  const imports: unknown[] = [];

  await runVisitor({ ImportDeclaration: (node) => imports.push(node) }, file);

  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({ type: "ImportDeclaration", source: { value: "vue" } });
  expect(Object.getOwnPropertyDescriptor(imports[0], "__doctorParent")).toMatchObject({
    value: file.scriptAst,
    enumerable: false,
  });
});

test("awaits SFC hooks before dispatching script and template visitors", async () => {
  const file = createFile();
  file.sfc = await parseSfcFile(file.path, "<template><div /></template>");
  file.scriptAst = parseScript("app.ts", 'import "vue"');
  const events: string[] = [];

  await runVisitor(
    {
      async SFC() {
        await Promise.resolve();
        events.push("sfc");
      },
      ScriptNode(node: { type: string }) {
        events.push(node.type);
      },
      ImportDeclaration() {
        events.push("import");
      },
      TemplateNode(node: { type: string }) {
        events.push(node.type);
      },
    },
    file,
  );

  expect(events).toEqual([
    "sfc",
    "Program",
    "ImportDeclaration",
    "import",
    "Literal",
    "VDocumentFragment",
  ]);
});

test("walks each AST once no matter how many visitors run", async () => {
  const file = createFile();
  file.scriptAst = parseScript("app.ts", "const a = 1; const b = 2");
  const program = file.scriptAst as { body: unknown[] };
  const statements = program.body;
  const body = vi.fn(() => statements);
  Object.defineProperty(program, "body", { get: body, enumerable: true });
  const children = vi.fn(() => []);
  Object.defineProperty(file.templateAst, "children", { get: children, enumerable: true });
  const visits = Array.from({ length: 5 }, () => 0);

  await runVisitors(
    visits.map((_, index) => ({
      ScriptNode() {
        visits[index]! += 1;
      },
      TemplateNode() {},
    })),
    file,
  );

  expect(body).toHaveBeenCalledOnce();
  expect(children).toHaveBeenCalledOnce();
  expect(new Set(visits).size).toBe(1);
  expect(visits[0]).toBeGreaterThan(2);
});

test("links every script parent before the first visitor runs", async () => {
  const file = createFile();
  file.scriptAst = parseScript("app.ts", "const a = 1; export const b = { c: [a] }");
  const program = file.scriptAst as { body: any[] };
  const deepest = program.body[1].declaration.declarations[0].init.properties[0].value.elements[0];
  const seen: boolean[] = [];

  await runVisitors(
    [0, 1, 2].map(() => ({
      ScriptNode(node: any) {
        if (node.type !== "Program") return;
        let current = deepest;
        while (current.__doctorParent) current = current.__doctorParent;
        seen.push(current === program);
      },
    })),
    file,
  );

  expect(seen).toEqual([true, true, true]);
  expect(Object.keys(deepest)).not.toContain("__doctorParent");
});

test("dispatches each node to visitors in order after awaiting every SFC hook", async () => {
  const file = createFile();
  file.sfc = await parseSfcFile(file.path, "<template><div /></template>");
  file.scriptAst = parseScript("app.ts", 'import "vue"');
  const events: string[] = [];
  const visitor = (name: string): RuleVisitor => ({
    async SFC() {
      await Promise.resolve();
      events.push(`${name}:sfc`);
    },
    ScriptNode(node: any) {
      if (node.type === "Program") events.push(`${name}:program`);
    },
    ImportDeclaration() {
      events.push(`${name}:import`);
    },
    TemplateNode(node: any) {
      if (node.type === "VDocumentFragment") events.push(`${name}:template`);
    },
  });

  await runVisitors([visitor("a"), visitor("b")], file);

  expect(events).toEqual([
    "a:sfc",
    "b:sfc",
    "a:program",
    "b:program",
    "a:import",
    "b:import",
    "a:template",
    "b:template",
  ]);
});
