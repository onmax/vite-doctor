import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { allDiagnostics, runDoctor } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";

const symlinkFixRule = createRule({
  meta: {
    id: "test/fix-symlink",
    title: "Fix symlink target",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: any) {
        if (node.type !== "Program") return;
        const start = ctx.file.text.indexOf("bad");
        if (start < 0) return;
        ctx.report(
          allDiagnostics.DOC9999({
            why: "The fixture contains bad.",
            fix: "Replace bad with good.",
          }),
          {
            ruleId: "test/fix-symlink",
            severity: "error",
            category: "correctness",
            file: ctx.file.path,
            range: ctx.range(node),
            fix: {
              kind: "safe",
              edits: [{ range: { start, end: start + 3 }, text: "good" }],
            },
          },
        );
      },
    };
  },
});

test("safe fixes preserve symlinked source paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-fix-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "doctor-fix-symlink-target-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vite: "^7.0.0" } }));
    const target = join(outside, "app.ts");
    writeFileSync(target, "export const value = bad;\n");
    const link = join(root, "src/app.ts");
    symlinkSync(target, link);

    const result = await runDoctor({
      root,
      framework: "vite",
      fix: true,
      cache: false,
      extensions: [
        defineDoctorExtension({
          name: "test-symlink-fix",
          rulePacks: [
            defineRulePack({
              name: "test-symlink-fix",
              version: "0.0.0",
              rules: [symlinkFixRule],
              presets: { recommended: [symlinkFixRule.meta.id] },
            }),
          ],
        }),
      ],
    });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("export const value = good;\n");
    expect(result.fixes).toEqual({ files: 1, edits: 1, skipped: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
