import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
  type DoctorRunResult,
} from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { readStoreFile } from "./cache-store-file.ts";

/** Reads every file a source file imports and reports imports of files that contain TODO. */
const importsTodo = createRule({
  meta: {
    id: "fixture/imports-todo",
    title: "Imports a TODO",
    category: "fixture",
    severity: "warn",
  },
  create(ctx) {
    const forbidden = forbiddenNames(ctx);
    for (const match of ctx.file.text.matchAll(/from "(\.\/[\w-]+)"/g)) {
      const target = join(dirname(ctx.file.path), `${match[1]}.ts`);
      if (!ctx.fs.readText(target)?.includes("TODO")) continue;
      ctx.report(
        allDiagnostics.DOC9999({
          why: `Imports ${match[1]}, which has a TODO.`,
          fix: "Finish it.",
        }),
        {
          range: ctx.range(match.index, match.index + match[0].length),
        },
      );
    }
    for (const name of forbidden) {
      const offset = ctx.file.text.indexOf(name);
      if (offset === -1) continue;
      ctx.report(allDiagnostics.DOC9999({ why: `Uses forbidden ${name}.`, fix: "Rename it." }), {
        range: ctx.range(offset, offset + name.length),
      });
    }
  },
});

/** Run-level Rule that lists the source directory and reads every file in it. */
const fixmeCount = createRule({
  meta: {
    id: "fixture/fixme-count",
    title: "Counts FIXME files",
    category: "fixture",
    severity: "info",
    execution: "manifest",
  },
  create(ctx) {
    return {
      onProjectEnd() {
        const names = (ctx.fs.readDir("src") ?? []).map((entry) => entry.name).sort();
        const fixme = names.filter((name) => ctx.fs.readText(`src/${name}`)?.includes("FIXME"));
        if (!fixme.length) return;
        ctx.report(
          allDiagnostics.DOC9999({ why: `FIXME in ${fixme.join(", ")}.`, fix: "Fix them." }),
          {
            file: join(ctx.project.root, "package.json"),
          },
        );
      },
    };
  },
});

// Remembered through ctx.cache, so the files that reuse it depend on markers.json too.
function forbiddenNames(ctx: Parameters<typeof importsTodo.create>[0]): string[] {
  const cached = ctx.cache.get<string[]>("fixture:forbidden");
  if (cached) return cached;
  const names = ctx.fs.readJson<{ forbidden?: string[] }>("markers.json")?.forbidden ?? [];
  ctx.cache.set("fixture:forbidden", names);
  return names;
}

const extension = defineDoctorExtension({
  name: "fixture/cache-parity",
  rulePacks: [
    defineRulePack({
      name: "fixture/cache-parity",
      version: "0.0.0",
      rules: [importsTodo, fixmeCount],
      presets: { recommended: [importsTodo.meta.id, fixmeCount.meta.id] },
    }),
  ],
});

function random(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state % max;
  };
}

function normalize(result: DoctorRunResult) {
  return {
    diagnostics: result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      diagnostic: { name: diagnostic.diagnostic.name, why: diagnostic.diagnostic.why },
    })),
    gaps: result.project.evidenceGaps,
    graph: result.graph,
    summary: result.summary,
  };
}

test.each([1, 2, 3, 4])(
  "warm-cache Diagnostics equal no-cache Diagnostics (seed %i)",
  async (seed) => {
    const next = random(seed);
    const root = mkdtempSync(join(tmpdir(), "doctor-cache-parity-"));
    const sources = new Map<string, string>();
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
      if (path.startsWith("src/")) sources.set(path, text);
    };
    const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const moduleText = (name: string, imports: string[], marker = "") =>
      `${imports.map((other) => `import { ${other} } from "./${other}";`).join("\n")}\nexport const ${name} = 1; ${marker}\n`;
    try {
      write(
        "package.json",
        JSON.stringify({ type: "module", devDependencies: { vite: "^7.0.0" } }),
      );
      write("markers.json", JSON.stringify({ forbidden: [] }));
      for (const name of names) write(`src/${name}.ts`, moduleText(name, []));
      write("src/index.ts", names.map((name) => `export { ${name} } from "./${name}";`).join("\n"));
      write(
        "src/app.ts",
        'import { alpha, beta } from "./index";\nexport const app = alpha + beta;\n',
      );
      const options = { root, cache: true, extensions: [extension] };
      await runViteDoctor(options);
      const outcomes = new Set<string>();
      let reused = 0;

      for (let step = 0; step < 10; step++) {
        const name = names[next(names.length)]!;
        switch (next(7)) {
          case 0:
            write(`src/${name}.ts`, moduleText(name, [], next(2) ? "// TODO" : ""));
            break;
          case 1: {
            const imports = names.filter((other) => other !== name && next(3) === 0);
            write(`src/${name}.ts`, moduleText(name, imports, next(2) ? "// FIXME" : ""));
            break;
          }
          case 2:
            write(
              "markers.json",
              JSON.stringify({
                forbidden: names.filter(() => next(4) === 0).map((item) => `${item} =`),
              }),
            );
            break;
          case 3: {
            const kept = names.filter(() => next(2) === 0);
            write(
              "src/index.ts",
              kept.map((item) => `export { ${item} } from "./${item}";`).join("\n"),
            );
            break;
          }
          case 4: {
            const path = `src/${name}.ts`;
            if (sources.has(path)) {
              rmSync(join(root, path));
              sources.delete(path);
            } else write(path, moduleText(name, []));
            break;
          }
          case 5: {
            const [path, text] = [...sources][next(sources.size)]!;
            const time = new Date(Date.now() - 60_000 * (1 + next(5)));
            writeFileSync(join(root, path), text);
            utimesSync(join(root, path), time, time);
            break;
          }
          default:
            write(
              "src/app.ts",
              `import { ${name} } from "./index";\nexport const app = ${name};\n`,
            );
        }
        if (next(3) === 0) await new Promise((resolve) => setTimeout(resolve, 150));

        const cached = await runViteDoctor(options);
        reused += readStoreFile(join(root, ".vite-doctor/cache/store.json")).index.lastWrite
          ?.ruleResultsReused as number;
        const uncached = await runViteDoctor({ ...options, cache: false });
        expect(normalize(cached), `seed ${seed}, step ${step}`).toEqual(normalize(uncached));
        outcomes.add(
          JSON.stringify(
            cached.diagnostics.map((item) => [item.ruleId, relative(root, item.file)]),
          ),
        );
      }
      // The sequence changes what Doctor reports and still reuses cached Rule results.
      expect(outcomes.size).toBeGreaterThan(1);
      expect(reused).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
