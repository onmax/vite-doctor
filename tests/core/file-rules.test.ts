import { expect, test } from "vite-plus/test";
import { allDiagnostics } from "../../src/core/index.ts";
import { createRule } from "../../src/core/primitives.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";

function reportingRule(id: string) {
  return createRule({
    meta: { id, title: id, category: "correctness", severity: "warn", requires: { script: true } },
    create(ctx) {
      return {
        ScriptNode(node: any) {
          if (node.type !== "VariableDeclarator") return;
          ctx.report(allDiagnostics.DOC9999({ why: "Fixture.", fix: "Fixture." }), {
            ruleId: id,
            severity: "warn",
            category: "correctness",
            range: ctx.range(node),
          });
        },
      };
    },
  });
}

const files = {
  "src/a.ts": "export const a = 1",
  "src/b.ts": "export const b = 2; export const c = 3",
};
const rules = [reportingRule("test/first"), reportingRule("test/second")];

test("file rule Diagnostics keep rule-major order across files", async () => {
  const result = await runProjectFixture({ files, framework: "vite", rules });

  expect(
    result.diagnostics.map(
      (diagnostic) => `${diagnostic.ruleId} ${diagnostic.file.split("/").at(-1)}`,
    ),
  ).toEqual([
    "test/first a.ts",
    "test/first b.ts",
    "test/first b.ts",
    "test/second a.ts",
    "test/second b.ts",
    "test/second b.ts",
  ]);
});

test("profiled runs attribute shared-walk time to each file rule", async () => {
  const result = await runProjectFixture({
    files,
    framework: "vite",
    rules,
    run: { profile: true },
  });

  expect(
    Object.fromEntries((result.ruleTimings ?? []).map((timing) => [timing.rule, timing.files])),
  ).toEqual({ "test/first": 2, "test/second": 2 });
});
