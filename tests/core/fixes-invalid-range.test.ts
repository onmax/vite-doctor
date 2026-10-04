import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import type { FixEdit } from "../../src/core/primitives.ts";
import { allDiagnostics, runDoctor } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";

function invalidRangeRule(edit: unknown, includeValidEdit: boolean) {
  return createRule({
    meta: {
      id: "test/fix-invalid-range",
      title: "Fix invalid range",
      category: "correctness",
      severity: "error",
      requires: { script: true },
    },
    create(ctx) {
      return {
        ScriptNode(node: any) {
          if (node.type !== "Program") return;
          ctx.report(
            allDiagnostics.DOC9999({ why: "The fixture has an invalid edit.", fix: "Fix it." }),
            {
              ruleId: "test/fix-invalid-range",
              severity: "error",
              category: "correctness",
              file: ctx.file.path,
              range: ctx.range(node),
              fix: {
                kind: "safe",
                edits: [
                  edit as FixEdit,
                  ...(includeValidEdit ? [{ range: { start: 21, end: 25 }, text: "false" }] : []),
                ],
              },
            },
          );
        },
      };
    },
  });
}

test.each(
  [
    { name: "out-of-bounds end", edit: { range: { start: 0, end: 28 }, text: "" } },
    { name: "negative start", edit: { range: { start: -1, end: 1 }, text: "" } },
    { name: "reversed range", edit: { range: { start: 2, end: 1 }, text: "" } },
    { name: "fractional offset", edit: { range: { start: 0.5, end: 1 }, text: "" } },
    { name: "NaN offset", edit: { range: { start: NaN, end: 1 }, text: "" } },
    { name: "infinite offset", edit: { range: { start: 0, end: Infinity }, text: "" } },
    { name: "null range", edit: { range: null, text: "" } },
    { name: "missing range", edit: { text: "" } },
    { name: "primitive range", edit: { range: 1, text: "" } },
    { name: "null edit", edit: null },
    { name: "undefined edit", edit: undefined },
    { name: "primitive edit", edit: 1 },
    { name: "missing text", edit: { range: { start: 0, end: 1 } } },
    { name: "non-string text", edit: { range: { start: 0, end: 1 }, text: null } },
  ].flatMap((fixture) => [
    { ...fixture, includeValidEdit: false },
    { ...fixture, includeValidEdit: true },
  ]),
)("$name is skipped (valid edit: $includeValidEdit)", async ({ edit, includeValidEdit }) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-fix-invalid-range-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vite: "^7.0.0" } }));
    const source = join(root, "src/app.ts");
    const original = "export const value = true;\n";
    writeFileSync(source, original);
    const rule = invalidRangeRule(edit, includeValidEdit);
    const result = await runDoctor({
      root,
      framework: "vite",
      fix: true,
      cache: false,
      extensions: [
        defineDoctorExtension({
          name: "test-invalid-range",
          rulePacks: [
            defineRulePack({
              name: "test-invalid-range",
              version: "0.0.0",
              rules: [rule],
              presets: { recommended: [rule.meta.id] },
            }),
          ],
        }),
      ],
    });

    expect(readFileSync(source, "utf8")).toBe(
      includeValidEdit ? "export const value = false;\n" : original,
    );
    expect(result.fixes).toEqual({
      files: includeValidEdit ? 1 : 0,
      edits: includeValidEdit ? 1 : 0,
      skipped: 1,
    });
    expect(result.diagnostics).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
