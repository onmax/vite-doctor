import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
  type Diagnostic,
  type DoctorRule,
} from "../../src/core/index.ts";
import { collectGitChangeInventory } from "../../src/core/internal/git-change-ranges.ts";
import { runViteDoctor } from "../../src/doctor.ts";

/** Reports imports of files that contain TODO, so a changed file depends on unchanged ones. */
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

/**
 * Declared project-scoped: reports on the TODO in each imported file, with the import as a
 * related location, so a changed file can receive a Diagnostic from an unchanged importer.
 */
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

function fixtureExtension(rules: DoctorRule[]) {
  return defineDoctorExtension({
    name: "fixture/changed-parity",
    rulePacks: [
      defineRulePack({
        name: "fixture/changed-parity",
        version: "0.0.0",
        rules,
        presets: { recommended: rules.map((rule) => rule.meta.id) },
      }),
    ],
  });
}

const extension = fixtureExtension([importsTodo, todoImportedBy]);

function random(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state % max;
  };
}

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function commit(root: string) {
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=Doctor",
    "-c",
    "user.email=doctor@example.test",
    "commit",
    "-qm",
    "step",
  );
}

/** The specification of `--changed`: Diagnostics of a full run that touch a changed line. */
async function filterToChangedLines(root: string, diagnostics: Diagnostic[]) {
  const inventory = await collectGitChangeInventory(root, undefined, (path) =>
    path.endsWith(".ts"),
  );
  if (inventory.status !== "available") throw new Error("Expected a Git inventory.");
  const ranges = new Map(
    inventory.files.flatMap((file) =>
      file.path ? [[join(root, file.path), file.reportRanges]] : [],
    ),
  );
  return diagnostics.filter((diagnostic) =>
    [diagnostic, ...(diagnostic.related ?? [])].some((location) => {
      const changed = ranges.get(location.file);
      if (!changed) return false;
      if (!location.range) return diagnostic.range === undefined;
      const text = readFileSync(location.file, "utf8");
      const { start, end, line } = location.range;
      const endLine =
        end <= start ? line : line + (text.slice(start, end - 1).match(/\n/g)?.length ?? 0);
      return changed.some((range) => line <= range.endLine && endLine >= range.startLine);
    }),
  );
}

const comparable = (diagnostics: Diagnostic[]) =>
  diagnostics.map(({ diagnostic, ...rest }) => ({ ...rest, code: diagnostic.name }));

test.each([1, 2, 3, 4, 5])(
  "--changed equals the full run filtered to changed lines (seed %i)",
  async (seed) => {
    const next = random(seed);
    const root = mkdtempSync(join(tmpdir(), "doctor-changed-parity-"));
    const names = ["alpha", "beta", "gamma", "delta"];
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const moduleText = (name: string, imports: string[], extra = "") =>
      [
        ...imports.map((other) => `import { ${other} } from "./${other}";`),
        `export const ${name} = 1;`,
        `export const ${name}Unused = 2; ${extra}`,
        "",
      ].join("\n");
    try {
      write(
        "package.json",
        JSON.stringify({ type: "module", devDependencies: { vite: "^7.0.0" } }),
      );
      write(".gitignore", ".vite-doctor\n");
      // Committed TODOs make every new importer the target of a cross-file report.
      for (const name of names)
        write(`src/${name}.ts`, moduleText(name, [], name === "beta" ? "" : "// TODO"));
      write("src/main.ts", 'import { alpha } from "./alpha";\nexport const main = alpha;\n');
      git(root, "init", "-q");
      commit(root);
      const options = {
        root,
        extensions: [extension],
        analyses: "dead-code,graph",
        rules: "fixture/,workspace/",
      };
      await runViteDoctor({ ...options, changed: true, cache: true });

      let reported = 0;
      let crossFile = 0;
      for (let step = 0; step < 10; step++) {
        const name = names[next(names.length)]!;
        const imports = names.filter((other) => other !== name && next(3) === 0);
        switch (next(5)) {
          case 0:
            write(`src/${name}.ts`, moduleText(name, imports, next(3) ? `// TODO ${step}` : ""));
            break;
          case 1:
            write(
              "src/main.ts",
              `import { ${name} } from "./${name}";\nexport const main = ${name};\n`,
            );
            break;
          case 2:
            write(`src/${name}.ts`, moduleText(name, imports, "// TODO"));
            commit(root);
            break;
          case 3:
            write(
              `src/extra${step}.ts`,
              `import { ${name} } from "./${name}";\nexport const extra = ${name};\n`,
            );
            break;
          default:
            write(`src/${name}.ts`, moduleText(name, imports));
        }

        const changedCached = await runViteDoctor({ ...options, changed: true, cache: true });
        const changedUncached = await runViteDoctor({ ...options, changed: true, cache: false });
        const full = await runViteDoctor({ ...options, cache: false });
        const expected = comparable(await filterToChangedLines(root, full.diagnostics));
        expect(comparable(changedUncached.diagnostics), `seed ${seed}, step ${step}`).toEqual(
          expected,
        );
        expect(comparable(changedCached.diagnostics), `seed ${seed}, step ${step}`).toEqual(
          expected,
        );
        reported += expected.length;
        crossFile += expected.filter((item) => item.ruleId === todoImportedBy.meta.id).length;
      }
      expect(reported).toBeGreaterThan(0);
      expect(crossFile).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("--changed reports parser evidence only for changed files", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-changed-gaps-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/broken.ts"), "export const = ;\n");
    writeFileSync(join(root, "src/app.ts"), "export const app = 1;\n");
    git(root, "init", "-q");
    commit(root);
    writeFileSync(join(root, "src/app.ts"), "export const app = 2;\n");
    const options = { root, framework: "vite" as const, cache: false };

    const full = await runViteDoctor(options);
    const changed = await runViteDoctor({ ...options, changed: true });

    expect(full.project.evidenceGaps?.map((gap) => gap.source)).toContain("script-parser");
    expect(changed.project.evidenceGaps ?? []).toEqual([]);

    writeFileSync(join(root, "src/broken.ts"), "export const = 1;\n");
    const touched = await runViteDoctor({ ...options, changed: true });
    expect(touched.project.evidenceGaps?.map((gap) => gap.files)).toEqual([
      [join(root, "src/broken.ts")],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undeclared cross-file report from a file Rule is an authoring error", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-changed-scope-"));
  const undeclared = createRule({
    meta: { id: "fixture/undeclared", title: "Undeclared", category: "fixture", severity: "warn" },
    create(ctx) {
      if (!ctx.file.path.endsWith("a.ts")) return;
      ctx.report(allDiagnostics.DOC9999({ why: "Elsewhere.", fix: "Look there." }), {
        file: join(ctx.project.root, "src/b.ts"),
      });
    },
  });
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src/b.ts"), "export const b = 1;\n");
    git(root, "init", "-q");
    commit(root);
    writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
    const options = { root, cache: false, extensions: [fixtureExtension([undeclared])] };
    for (const run of [options, { ...options, changed: true }])
      await expect(runViteDoctor(run)).rejects.toMatchObject({
        name: "DOC0030",
        message: expect.stringContaining('"fixture/undeclared"'),
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
