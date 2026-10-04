import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { allDiagnostics, createRule, createTextReport } from "../../src/core/index.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";

test("text output exposes a fix run whose only edit was skipped", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    files: { "src/app.ts": "export const value = true;" },
    run: { fix: true, cache: false },
    rules: [
      createRule({
        meta: {
          id: "test/missing-fix",
          title: "Missing fix target",
          category: "correctness",
          severity: "warn",
          requires: { script: true },
        },
        create(ctx) {
          return {
            ScriptNode(node: any) {
              if (node.type !== "Program") return;
              ctx.report(
                allDiagnostics.DOC9999({
                  why: "Missing source fixture.",
                  fix: "Restore the source.",
                }),
                {
                  ruleId: "test/missing-fix",
                  severity: "warn",
                  category: "correctness",
                  file: join(ctx.project.root, "deleted.ts"),
                  fix: { kind: "safe", edits: [{ range: { start: 0, end: 1 }, text: "x" }] },
                },
              );
            },
          };
        },
      }),
    ],
  });
  expect(result.fixes).toEqual({ files: 0, edits: 0, skipped: 1 });
  expect(createTextReport(result)).toContain("Fixes applied: 0 edits in 0 files, 1 skipped");
  for (const fixes of [undefined, { files: 0, edits: 0, skipped: 0 }]) {
    expect(createTextReport({ ...result, fixes })).not.toContain("Fixes applied:");
  }
  expect(createTextReport({ ...result, fixes: { files: 1, edits: 2, skipped: 3 } })).toContain(
    "Fixes applied: 2 edits in 1 files, 3 skipped",
  );
});
