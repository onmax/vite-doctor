import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { allDiagnostics, runDoctor } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";

const hooks = vi.hoisted(() => ({ afterWrite: undefined as ((file: string) => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      fs.writeFileSync(...args);
      hooks.afterWrite?.(String(args[0]));
    },
  };
});

afterEach(() => {
  hooks.afterWrite = undefined;
});

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
      Program() {
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
              edits: [{ range: { start: 0, end: 5 }, text: "let" }],
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

test.each(["deleted", "replaced", "modified", "unchanged"] as const)(
  "safe fixes respect a source that is %s before replacement",
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), "vite-doctor-fixes-"));
    const generated = join(root, "generated");
    const target = join(generated, "missing.ts");
    try {
      await writeFile(join(root, "package.json"), "{}");
      await writeFile(join(root, "src.ts"), "const source = true;\n");
      await mkdir(generated);
      await writeFile(target, "const original = true;\n");
      hooks.afterWrite = (file) => {
        if (!file.startsWith(`${target}.vite-doctor-`)) return;
        if (change === "unchanged") return;
        if (change !== "modified") rmSync(target);
        if (change !== "deleted") writeFileSync(target, "const replacement = true;\n");
      };

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
      expect(result.fixes).toEqual(
        change === "unchanged"
          ? { files: 1, edits: 1, skipped: 0 }
          : { files: 0, edits: 0, skipped: 1 },
      );
      if (change === "deleted") {
        expect(existsSync(target)).toBe(false);
        expect(readdirSync(generated)).toEqual([]);
      } else {
        expect(readFileSync(target, "utf8")).toBe(
          change === "unchanged" ? "let original = true;\n" : "const replacement = true;\n",
        );
        expect(readdirSync(generated)).toEqual(["missing.ts"]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

const insertionRule = createRule({
  meta: {
    id: "test/fix-insertion",
    title: "Fix insertion",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    return {
      Program(node: any) {
        ctx.report(
          allDiagnostics.DOC9999({ why: "The fixture needs a header.", fix: "Add a header." }),
          {
            ruleId: "test/fix-insertion",
            severity: "error",
            category: "correctness",
            file: ctx.file.path,
            range: ctx.range(node),
            fix: {
              kind: "safe",
              edits: [{ range: { start: 0, end: 0 }, text: "// generated\n" }],
            },
          },
        );
      },
    };
  },
});

test("safe insertion fixes do not abort the Doctor Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-fix-insertion-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
    );
    const source = join(root, "src/app.ts");
    await writeFile(source, "export const value = true;\n");
    const result = await runDoctor({
      root,
      framework: "vite",
      fix: true,
      cache: false,
      extensions: [
        defineDoctorExtension({
          name: "test-insertion",
          rulePacks: [
            defineRulePack({
              name: "test-insertion",
              version: "0.0.0",
              rules: [insertionRule],
              presets: { recommended: [insertionRule.meta.id] },
            }),
          ],
        }),
      ],
    });

    expect(readFileSync(source, "utf8")).toBe("// generated\nexport const value = true;\n");
    expect(result.fixes).toEqual({ files: 1, edits: 1, skipped: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { offset: 0, expected: "!Abc\n" },
  { offset: 1, expected: "A!bc\n" },
])(
  "safe insertions at replacement boundary $offset are preserved",
  async ({ offset, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "doctor-fix-boundary-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      );
      const source = join(root, "src/app.ts");
      await writeFile(source, "abc\n");
      const boundaryRule = createRule({
        meta: {
          id: "test/fix-boundary",
          title: "Fix boundary",
          category: "correctness",
          severity: "error",
          requires: { script: true },
        },
        create(ctx) {
          return {
            Program(node: any) {
              const report = (edits: { start: number; end: number; text: string }[]) =>
                ctx.report(
                  allDiagnostics.DOC9999({
                    why: "The fixture needs an edit.",
                    fix: "Apply the edit.",
                  }),
                  {
                    ruleId: "test/fix-boundary",
                    severity: "error",
                    category: "correctness",
                    file: ctx.file.path,
                    range: ctx.range(node),
                    fix: {
                      kind: "safe",
                      edits: edits.map((edit) => ({ range: edit, text: edit.text })),
                    },
                  },
                );
              report([
                { start: 0, end: 1, text: "A" },
                { start: offset, end: offset, text: "!" },
              ]);
            },
          };
        },
      });
      const result = await runDoctor({
        root,
        framework: "vite",
        fix: true,
        cache: false,
        extensions: [
          defineDoctorExtension({
            name: "test-fix-boundary",
            rulePacks: [
              defineRulePack({
                name: "test-fix-boundary",
                version: "0.0.0",
                rules: [boundaryRule],
                presets: { recommended: [boundaryRule.meta.id] },
              }),
            ],
          }),
        ],
      });

      expect(readFileSync(source, "utf8")).toBe(expected);
      expect(result.fixes).toEqual({ files: 1, edits: 2, skipped: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
