import { expect, expectTypeOf, test, vi } from "vite-plus/test";
import type { RuleVisitor, ScriptAstNodeOf, SourceFileHandle } from "../../src/core/primitives.ts";
import { createRule } from "../../src/extension.ts";
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

test.each<keyof RuleVisitor>(["SFC", "onProjectStart", "Identifier", "ImportDeclaration"])(
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
      Program(node) {
        events.push(node.type);
      },
      ImportDeclaration() {
        events.push("import");
      },
      Literal(node) {
        events.push(node.type);
      },
      "Program:exit"() {
        events.push("program:exit");
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
    "import",
    "Literal",
    "program:exit",
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
      Identifier() {
        visits[index]! += 1;
      },
      TemplateNode() {},
    })),
    file,
  );

  expect(body).toHaveBeenCalledOnce();
  expect(children).toHaveBeenCalledOnce();
  expect(visits).toEqual([2, 2, 2, 2, 2]);
});

test("links every script parent before the first visitor runs", async () => {
  const file = createFile();
  file.scriptAst = parseScript("app.ts", "const a = 1; export const b = { c: [a] }");
  const program = file.scriptAst as { body: any[] };
  const deepest = program.body[1].declaration.declarations[0].init.properties[0].value.elements[0];
  const seen: boolean[] = [];

  await runVisitors(
    [0, 1, 2].map(() => ({
      Program() {
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
    Program() {
      events.push(`${name}:program`);
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

test.each([1, 2])(
  "script traversal snapshots children before %i visitors dispatch",
  async (count) => {
    const file = createFile();
    file.scriptAst = parseScript("app.ts", "const removed = 1; const replaced = 2");
    const program = file.scriptAst as { body: unknown[] };
    const original = [...program.body];
    const replacement = { type: "EmptyStatement" };
    const inserted = { type: "DebuggerStatement" };
    const visits: unknown[][] = Array.from({ length: count }, () => []);
    const visitors = visits.map((seen, index): RuleVisitor => {
      const visit = (node: unknown) => {
        seen.push(node);
        if (node === program && index === 0) {
          program.body.splice(0, 1);
          program.body[0] = replacement;
          program.body.push(inserted);
        }
      };
      return {
        Program: visit,
        VariableDeclaration: visit,
        EmptyStatement: visit,
        DebuggerStatement: visit,
      };
    });

    if (count === 1) await runVisitor(visitors[0]!, file);
    else await runVisitors(visitors, file);

    for (const seen of visits) {
      for (const node of original) expect(seen).toContain(node);
      expect(seen).not.toContain(replacement);
      expect(seen).not.toContain(inserted);
    }
  },
);

test("dispatches each node only to visitors for its type", async () => {
  const file = createFile();
  file.scriptAst = parseScript("app.ts", "const a = f(b); g()");
  const calls: string[] = [];
  const identifiers: string[] = [];

  await runVisitor(
    {
      CallExpression(node) {
        calls.push(node.type);
      },
      Identifier(node) {
        identifiers.push(node.name);
      },
    },
    file,
  );

  expect(calls).toEqual(["CallExpression", "CallExpression"]);
  expect(identifiers).toEqual(["a", "f", "b", "g"]);
});

test("runs exit visitors after the node's children in rule order", async () => {
  const file = createFile();
  file.scriptAst = parseScript("app.ts", "f(g(1)); h()");
  const events: string[] = [];
  const visitor = (name: string): RuleVisitor => ({
    CallExpression(node) {
      events.push(`${name}:enter:${(node.callee as { name: string }).name}`);
    },
    "CallExpression:exit"(node) {
      events.push(`${name}:exit:${(node.callee as { name: string }).name}`);
    },
    "Program:exit"() {
      events.push(`${name}:program:exit`);
    },
  });

  await runVisitors([visitor("a"), visitor("b")], file);

  expect(events).toEqual([
    "a:enter:f",
    "b:enter:f",
    "a:enter:g",
    "b:enter:g",
    "a:exit:g",
    "b:exit:g",
    "a:exit:f",
    "b:exit:f",
    "a:enter:h",
    "b:enter:h",
    "a:exit:h",
    "b:exit:h",
    "a:program:exit",
    "b:program:exit",
  ]);
});

test("visitor keys type their node parameter", () => {
  createRule({
    meta: { id: "test/types", title: "Types", category: "correctness", severity: "warn" },
    create() {
      return {
        CallExpression(node) {
          expectTypeOf(node).toEqualTypeOf<ScriptAstNodeOf<"CallExpression">>();
        },
        "ImportDeclaration:exit"(node) {
          expectTypeOf(node.source.value).toEqualTypeOf<string>();
        },
        Identifier(node) {
          expectTypeOf(node.name).toEqualTypeOf<string>();
        },
      };
    },
  });
  // @ts-expect-error ScriptNode was removed in favor of node type visitors.
  const legacy: RuleVisitor = { ScriptNode() {} };
  expect(legacy).toBeDefined();
});
