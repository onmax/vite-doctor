import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
  type Diagnostic,
} from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";

/** File-scoped: reports each import of a file that contains TODO. */
const importsTodo = createRule({
  meta: {
    id: "fixture/imports-todo",
    title: "Imports a TODO",
    category: "fixture",
    severity: "warn",
  },
  create(ctx) {
    for (const match of ctx.file.text.matchAll(/from "(\.\/[\w-]+)"/g)) {
      const target = join(dirname(ctx.file.path), `${match[1]}.ts`);
      if (!ctx.fs.readText(target)?.includes("TODO")) continue;
      ctx.report(
        allDiagnostics.DOC9999({
          why: `Imports ${match[1]}, which has a TODO.`,
          fix: "Finish it.",
        }),
        { range: ctx.range(match.index, match.index + match[0].length) },
      );
    }
  },
});

/** Project-scoped: reports into the imported file, with the importer as a related location. */
const todoImportedBy = createRule({
  meta: {
    id: "fixture/todo-imported-by",
    title: "TODO in an imported file",
    category: "fixture",
    severity: "info",
    reportScope: "project",
  },
  create(ctx) {
    for (const match of ctx.file.text.matchAll(/from "(\.\/[\w-]+)"/g)) {
      const target = join(dirname(ctx.file.path), `${match[1]}.ts`);
      const text = ctx.fs.readText(target);
      const offset = text?.indexOf("TODO") ?? -1;
      if (offset === -1) continue;
      ctx.report(
        allDiagnostics.DOC9999({
          why: `TODO imported by ${ctx.file.relativePath}.`,
          fix: "Finish it.",
        }),
        {
          file: target,
          range: ctx.helpers.rangeFromOffsets(target, text!, offset, offset + 4),
          related: [
            {
              file: ctx.file.path,
              range: ctx.range(match.index, match.index + match[0].length),
              message: "Imported here",
            },
          ],
        },
      );
    }
  },
});

const rules = [importsTodo, todoImportedBy];
const extension = defineDoctorExtension({
  name: "fixture/affected-files",
  rulePacks: [
    defineRulePack({
      name: "fixture/affected-files",
      version: "0.0.0",
      rules,
      presets: { recommended: rules.map((rule) => rule.meta.id) },
    }),
  ],
});

const comparable = (diagnostics: Diagnostic[]) =>
  diagnostics.map(({ diagnostic, cacheHit: _, ...rest }) => ({ ...rest, code: diagnostic.name }));

function withProject(
  run: (root: string, write: (path: string, text: string) => void) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "doctor-affected-files-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", JSON.stringify({ type: "module", devDependencies: { vite: "^7.0.0" } }));
  write("src/todo.ts", "export const todo = 1; // TODO\n");
  write("src/clean.ts", "export const clean = 1;\n");
  write("src/main.ts", 'import { todo } from "./todo";\nexport const main = todo;\n');
  write("src/other.ts", 'import { todo } from "./todo";\nexport const other = todo;\n');
  return run(root, write).finally(() => rmSync(root, { recursive: true, force: true }));
}

test.each([
  [["src/main.ts"]],
  [["src/todo.ts"]],
  [["src/clean.ts"]],
  [["src/main.ts", "src/deleted.ts"]],
])(
  "an affected-files run equals the full run filtered to Diagnostics touching %j",
  async (affected) => {
    await withProject(async (root, write) => {
      const options = { root, extensions: [extension], rules: "fixture/" };
      await runViteDoctor({ ...options, cache: true });
      write("src/main.ts", 'import { todo } from "./todo";\nexport const main = todo + 1;\n');

      const files = new Set(affected.map((file) => join(root, file)));
      const full = await runViteDoctor({ ...options, cache: false });
      const expected = comparable(
        full.diagnostics.filter((diagnostic) =>
          [diagnostic, ...(diagnostic.related ?? [])].some((location) => files.has(location.file)),
        ),
      );
      const cached = await runViteDoctor({ ...options, affectedFiles: affected, cache: true });
      const uncached = await runViteDoctor({ ...options, affectedFiles: affected, cache: false });

      expect(comparable(cached.diagnostics)).toEqual(expected);
      expect(comparable(uncached.diagnostics)).toEqual(expected);
      expect(uncached.scope).toEqual({
        mode: "affected",
        files: affected.filter((file) => file !== "src/deleted.ts").length,
      });
    });
  },
);

test("an affected-files run reports parser evidence only for affected files", async () => {
  await withProject(async (root, write) => {
    write("src/broken.ts", "export const = ;\n");
    const options = { root, framework: "vite" as const, cache: false };

    const unaffected = await runViteDoctor({ ...options, affectedFiles: ["src/main.ts"] });
    const affected = await runViteDoctor({ ...options, affectedFiles: ["src/broken.ts"] });

    expect(unaffected.project.evidenceGaps ?? []).toEqual([]);
    expect(affected.project.evidenceGaps?.map((gap) => gap.files)).toEqual([
      [join(root, "src/broken.ts")],
    ]);
  });
});
