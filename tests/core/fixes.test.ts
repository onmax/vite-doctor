import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { allDiagnostics, runDoctor } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";

const missingFileFixRule = createRule({
  meta: {
    id: "fixture/missing-file-fix",
    title: "Missing file fix",
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
            why: "The generated source needs an update.",
            fix: "Regenerate the missing source file.",
          }),
          {
            ruleId: "fixture/missing-file-fix",
            severity: "warn",
            category: "correctness",
            file: join(ctx.project.root, "generated/missing.ts"),
            fix: {
              kind: "safe",
              edits: [{ range: { start: 0, end: 0 }, text: "export {}\n" }],
            },
          },
        );
      },
    };
  },
});

const extension = defineDoctorExtension({
  name: "fixture/missing-file-fix",
  rulePacks: [
    defineRulePack({
      name: "fixture/missing-file-fix",
      version: "0.0.0",
      rules: [missingFileFixRule],
      presets: { recommended: ["fixture/missing-file-fix"] },
    }),
  ],
});

test("safe fixes for missing source files are skipped without aborting the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-fixes-"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "src.ts"), "const source = true;\n");

    const result = await runDoctor({
      root,
      framework: "vite",
      fix: true,
      cache: false,
      extensions: [extension],
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ ruleId: "fixture/missing-file-fix" }),
    ]);
    expect(result.fixes).toEqual({ files: 0, edits: 0, skipped: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
