import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { allDiagnostics, runDoctor } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";

const invalidRangeRule = createRule({
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
              edits: [{ range: { start: 0, end: ctx.file.text.length + 1 }, text: "" }],
            },
          },
        );
      },
    };
  },
});

test("malformed safe-fix ranges are skipped without aborting the Doctor Run", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-fix-invalid-range-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vite: "^7.0.0" } }));
    const source = join(root, "src/app.ts");
    const original = "export const value = true;\n";
    writeFileSync(source, original);
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
              rules: [invalidRangeRule],
              presets: { recommended: [invalidRangeRule.meta.id] },
            }),
          ],
        }),
      ],
    });

    expect(readFileSync(source, "utf8")).toBe(original);
    expect(result.fixes).toEqual({ files: 0, edits: 0, skipped: 1 });
    expect(result.diagnostics).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
