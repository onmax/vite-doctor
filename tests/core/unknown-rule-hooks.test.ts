import { expect, test } from "vite-plus/test";
import { createRule, type DoctorRule, type RuleMeta } from "../../src/core/primitives.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";

function hookRule(visitor: Record<string, unknown>, meta: Partial<RuleMeta> = {}): DoctorRule {
  return createRule({
    meta: { id: "fixture/hooks", title: "Hooks", category: "fixture", severity: "warn", ...meta },
    create: () => visitor as never,
  });
}

function run(rule: DoctorRule) {
  return runProjectFixture({
    framework: "vue",
    files: {
      "src/a.ts": "export const a = f();\n",
      "src/App.vue": "<template><div /></template>\n",
    },
    rules: [rule],
  });
}

test("a removed ScriptNode hook stops the run and names the replacement", async () => {
  await expect(run(hookRule({ ScriptNode() {} }))).rejects.toMatchObject({
    name: "DOC0034",
    message: expect.stringMatching(/"fixture\/hooks".*ScriptNode/s),
    fix: expect.stringContaining("Move its body into visitors for the node types it checked"),
  });
});

test("a removed TemplateNode hook points at template visitors", async () => {
  await expect(run(hookRule({ TemplateNode() {} }))).rejects.toMatchObject({
    name: "DOC0034",
    fix: expect.stringContaining("template: { element(node) {} }"),
  });
});

test("a misspelled script hook suggests the node type", async () => {
  await expect(run(hookRule({ CallExpresion() {} }))).rejects.toMatchObject({
    name: "DOC0034",
    message: expect.stringContaining("CallExpresion"),
    fix: expect.stringContaining('"CallExpression"'),
  });
  await expect(run(hookRule({ "Identifer:exit"() {} }))).rejects.toMatchObject({
    fix: expect.stringContaining('"Identifier:exit"'),
  });
});

test("a misspelled template hook suggests the template node kind", async () => {
  await expect(run(hookRule({ template: { elemnt() {} } }))).rejects.toMatchObject({
    name: "DOC0034",
    message: expect.stringContaining("template.elemnt"),
    fix: expect.stringContaining('"element"'),
  });
});

test("lifecycle hooks on a file Rule and node visitors on a workspace Rule are rejected", async () => {
  await expect(run(hookRule({ onProjectEnd() {} }))).rejects.toMatchObject({
    name: "DOC0034",
    fix: expect.stringContaining('meta.execution to "workspace" or "manifest"'),
  });
  await expect(
    run(hookRule({ CallExpression() {} }, { execution: "workspace" })),
  ).rejects.toMatchObject({
    name: "DOC0034",
    fix: expect.stringContaining('meta.execution to "file"'),
  });
});

test("known hooks run without an authoring error", async () => {
  const seen: string[] = [];
  await run(
    hookRule({
      CallExpression: () => seen.push("call"),
      "Program:exit": () => seen.push("program:exit"),
      SFC: () => seen.push("sfc"),
      template: { element: () => seen.push("element"), "root:exit": () => seen.push("root:exit") },
      notAHook: 1,
    }),
  );
  await run(hookRule({ onProjectStart: () => seen.push("project") }, { execution: "manifest" }));
  expect(seen.sort()).toEqual(["call", "element", "program:exit", "project", "root:exit", "sfc"]);
});

for (const firstVisitor of ["empty", "valid"] as const) {
  test(`unknown hooks on later files are rejected after an earlier ${firstVisitor} visitor`, async () => {
    const seen: string[] = [];
    const rule = createRule({
      meta: { id: "fixture/hooks", title: "Hooks", category: "fixture", severity: "warn" },
      create(ctx) {
        seen.push(ctx.file.relativePath);
        if (ctx.file.isVueSfc) return { ScriptNode() {} } as never;
        return firstVisitor === "empty" ? {} : { Program() {} };
      },
    });
    await expect(
      runProjectFixture({
        framework: "vue",
        files: {
          "src/00-script.ts": "export const a = 1;\n",
          "src/zz-component.vue": "<script setup>f();</script><template><div /></template>\n",
        },
        rules: [rule],
      }),
    ).rejects.toMatchObject({
      name: "DOC0034",
      message: expect.stringMatching(/"fixture\/hooks".*ScriptNode/s),
    });
    expect(seen).toEqual(["src/00-script.ts", "src/zz-component.vue"]);
  });
}
