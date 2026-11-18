import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
  type DoctorConfig,
  type DoctorRunResult,
} from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import nuxtDoctorModule, { writeManifest } from "../../src/rule-packs/nuxt/module.ts";

/** Reports each file once, echoing its options so tests can see which config applied. */
const everyFile = createRule({
  meta: { id: "fixture/every-file", title: "Every file", category: "fixture", severity: "warn" },
  create(ctx) {
    ctx.report(
      allDiagnostics.DOC9999({
        why: `options:${JSON.stringify(ctx.options ?? null)}`,
        fix: "Nothing.",
      }),
      { range: ctx.range(0, 1) },
    );
  },
});

/** Only the strict Preset selects this Rule. */
const strictOnly = createRule({
  meta: { id: "fixture/strict-only", title: "Strict only", category: "fixture", severity: "info" },
  create(ctx) {
    ctx.report(allDiagnostics.DOC9999({ why: "strict", fix: "Nothing." }), {
      range: ctx.range(0, 1),
    });
  },
});

/** A workspace Rule that reports into every source file, so overrides apply per Diagnostic. */
const workspaceReport = createRule({
  meta: {
    id: "fixture/workspace-report",
    title: "Workspace report",
    category: "fixture",
    severity: "warn",
    execution: "workspace",
  },
  create(ctx) {
    return {
      onWorkspaceEnd() {
        for (const file of ["src/lib.ts", "playground/demo.ts"])
          ctx.report(allDiagnostics.DOC9999({ why: "workspace", fix: "Nothing." }), {
            file: join(ctx.project.root, file),
          });
      },
    };
  },
});

const extension = defineDoctorExtension({
  name: "fixture/overrides",
  rulePacks: [
    defineRulePack({
      name: "fixture/overrides",
      version: "0.0.0",
      rules: [everyFile, strictOnly, workspaceReport],
      presets: {
        recommended: [everyFile.meta.id, workspaceReport.meta.id],
        strict: [everyFile.meta.id, workspaceReport.meta.id, strictOnly.meta.id],
      },
    }),
  ],
});

function withProject(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-config-overrides-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", JSON.stringify({ type: "module" }));
  write("src/lib.ts", "export const lib = 1;\n");
  write("playground/demo.ts", "export const demo = 1;\n");
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function run(root: string, config: DoctorConfig, cache = false) {
  return runViteDoctor({
    root,
    framework: "vite",
    extends: ["fixture/overrides/recommended"],
    extensions: [extension],
    config,
    cache,
  });
}

/** `ruleId file severity message` for each Diagnostic, sorted. */
function findings(result: DoctorRunResult) {
  return result.diagnostics
    .map(
      (item) =>
        `${item.ruleId} ${relative(result.root, item.file)} ${item.severity} ${item.message}`,
    )
    .sort();
}

test("an override turns a Rule off for the files it matches", async () => {
  await withProject(async (root) => {
    const result = await run(root, {
      overrides: [
        {
          files: ["playground/**"],
          rules: { "fixture/every-file": "off", "fixture/workspace-report": "off" },
        },
      ],
    });
    expect(findings(result)).toEqual([
      "fixture/every-file src/lib.ts warn options:null",
      "fixture/workspace-report src/lib.ts warn workspace",
    ]);
  });
});

test("overrides apply in order, so a later matching override wins", async () => {
  await withProject(async (root) => {
    const result = await run(root, {
      rules: { "fixture/every-file": ["error", { from: "top" }] },
      overrides: [
        { files: ["**/*.ts"], rules: { "fixture/every-file": ["info", { from: "all" }] } },
        { files: ["src/**"], rules: { "fixture/every-file": "warn" } },
      ],
    });
    // A severity without options keeps the options an earlier entry set, as in ESLint.
    expect(findings(result).filter((line) => line.startsWith("fixture/every-file"))).toEqual([
      'fixture/every-file playground/demo.ts info options:{"from":"all"}',
      'fixture/every-file src/lib.ts warn options:{"from":"all"}',
    ]);
  });
});

test("an override turns back on a Rule the top-level config turned off", async () => {
  await withProject(async (root) => {
    const result = await run(root, {
      rules: { "fixture/every-file": "off", "fixture/workspace-report": "off" },
      overrides: [
        {
          files: ["src/**"],
          rules: { "fixture/every-file": "error", "fixture/workspace-report": "error" },
        },
      ],
    });
    expect(findings(result)).toEqual([
      "fixture/every-file src/lib.ts error options:null",
      "fixture/workspace-report src/lib.ts error workspace",
    ]);
  });
});

test("a severity turns on a Rule no selected Preset includes", async () => {
  await withProject(async (root) => {
    const topLevel = await run(root, { rules: { "fixture/strict-only": "warn" } });
    expect(findings(topLevel).filter((line) => line.startsWith("fixture/strict-only"))).toEqual([
      "fixture/strict-only playground/demo.ts warn strict",
      "fixture/strict-only src/lib.ts warn strict",
    ]);

    const scoped = await run(root, {
      overrides: [{ files: ["src/**"], rules: { "fixture/strict-only": "error" } }],
    });
    expect(findings(scoped).filter((line) => line.startsWith("fixture/strict-only"))).toEqual([
      "fixture/strict-only src/lib.ts error strict",
    ]);
  });
});

test("an override's extends selects a Preset for the files it matches", async () => {
  await withProject(async (root) => {
    const result = await run(root, {
      overrides: [{ files: ["src/**"], extends: ["fixture/overrides/strict"] }],
    });
    expect(findings(result).filter((line) => line.startsWith("fixture/strict-only"))).toEqual([
      "fixture/strict-only src/lib.ts info strict",
    ]);
  });
});

test("a later Preset re-enables a Rule, but its own rules entries take precedence", async () => {
  await withProject(async (root) => {
    const result = await run(root, {
      overrides: [
        { files: ["**/*.ts"], rules: { [strictOnly.meta.id]: "off" } },
        { files: ["**/*.ts"], extends: ["fixture/overrides/strict"] },
        {
          files: ["playground/**"],
          extends: ["fixture/overrides/strict"],
          rules: { [strictOnly.meta.id]: "off" },
        },
      ],
    });
    expect(findings(result).filter((line) => line.startsWith(strictOnly.meta.id))).toEqual([
      "fixture/strict-only src/lib.ts info strict",
    ]);
  });
});

test("a later Preset and severity retain options across off overrides", async () => {
  await withProject(async (root) => {
    const result = await run(root, {
      rules: { [everyFile.meta.id]: ["warn", { from: "top" }] },
      overrides: [
        { files: ["**/*.ts"], rules: { [everyFile.meta.id]: "off" } },
        {
          files: ["src/**"],
          extends: ["fixture/overrides/strict"],
          rules: { [everyFile.meta.id]: "error" },
        },
      ],
    });
    expect(findings(result).filter((line) => line.startsWith(everyFile.meta.id))).toEqual([
      'fixture/every-file src/lib.ts error options:{"from":"top"}',
    ]);
  });
});

test.each([
  { rules: { "pinia/stores/store-name-matches-id": "error" } } as const,
  { extends: ["pinia/strict"] },
])("override-only rules retain their Pack's automatic package scope: %j", async (selection) => {
  await withProject(async (root) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    for (const name of ["app", "sibling"]) {
      const directory = join(root, "packages", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name, dependencies: name === "app" ? { pinia: "^3.0.0" } : {} }),
      );
      writeFileSync(
        join(directory, "store.ts"),
        'import { defineStore } from "pinia"; export const useWrongStore = defineStore("right", {});\n',
      );
    }
    const options = {
      root,
      cache: false,
      rules: "pinia/stores/store-name-matches-id",
      config: { overrides: [{ files: ["packages/**"], ...selection }] },
    };
    const piniaFiles = (result: DoctorRunResult) =>
      result.diagnostics
        .filter((item) => item.code === "PINIA0002")
        .map((item) => relative(root, item.file));
    expect(piniaFiles(await runViteDoctor(options))).toEqual(["packages/app/store.ts"]);
    expect(
      piniaFiles(await runViteDoctor({ ...options, extends: ["auto", "pinia/strict"] })),
    ).toEqual(["packages/app/store.ts", "packages/sibling/store.ts"]);
    expect(
      piniaFiles(
        await runViteDoctor({
          ...options,
          config: { rules: { "pinia/stores/store-name-matches-id": "error" } },
        }),
      ),
    ).toEqual(["packages/app/store.ts", "packages/sibling/store.ts"]);
  });
});

test.each([false, true])(
  "project-reporting Rules analyze sources disabled for reporting (source options: %s)",
  async (sourceOptions) => {
    await withProject(async (root) => {
      const crossFile = createRule({
        meta: { ...strictOnly.meta, reportScope: "project" },
        create(ctx) {
          if (ctx.file.relativePath !== "playground/demo.ts") return;
          if (sourceOptions && ctx.options !== "analyze") return;
          ctx.report(allDiagnostics.DOC9999({ why: "cross-file", fix: "Nothing." }), {
            file: join(root, "src/lib.ts"),
          });
        },
      });
      const overrides: NonNullable<DoctorConfig["overrides"]> = [
        { files: ["src/**"], rules: { [strictOnly.meta.id]: "error" } },
      ];
      if (sourceOptions)
        overrides.push(
          { files: ["playground/**"], rules: { [strictOnly.meta.id]: ["info", "analyze"] } },
          { files: ["playground/**"], rules: { [strictOnly.meta.id]: "off" } },
        );
      const result = await runViteDoctor({
        root,
        affectedFiles: ["src/lib.ts"],
        cache: false,
        extensions: [
          defineDoctorExtension({
            name: "fixture/cross-file",
            rulePacks: [
              defineRulePack({
                name: "fixture/cross-file",
                version: "0.0.0",
                rules: [crossFile],
                presets: { recommended: [crossFile.meta.id] },
              }),
            ],
          }),
        ],
        config: { extends: [], overrides },
      });
      expect(findings(result)).toEqual(["fixture/strict-only src/lib.ts error cross-file"]);
    });
  },
);

test("registered Nuxt module sources match their physical paths", async () => {
  await withProject(async (root) => {
    mkdirSync(join(root, ".nuxt"));
    writeFileSync(join(root, "nuxt.config.ts"), "export default {}\n");
    writeFileSync(
      join(root, ".nuxt/doctor.manifest.json"),
      JSON.stringify({
        moduleSources: [{ module: "fixture-module", root: join(root, "src") }],
      }),
    );
    const result = await runViteDoctor({
      root,
      framework: "nuxt",
      cache: false,
      extensions: [extension],
      config: {
        extends: [],
        overrides: [{ files: ["src/**"], rules: { [strictOnly.meta.id]: "error" } }],
      },
    });
    expect(findings(result).filter((line) => line.startsWith(strictOnly.meta.id))).toEqual([
      "fixture/strict-only src/lib.ts error strict",
    ]);
  });
});

test.each(["manifest", "workspace"] as const)(
  "tuple options for a %s Rule are rejected in overrides",
  async (execution) => {
    await withProject(async (root) => {
      const ruleId =
        execution === "manifest" ? "package/no-pinned-singleton" : workspaceReport.meta.id;
      await expect(
        run(root, {
          overrides: [
            { files: ["package.json"], rules: { [ruleId]: ["error", { singletons: ["comark"] }] } },
          ],
        }),
      ).rejects.toMatchObject({ name: "DOC0035", message: expect.stringContaining(ruleId) });
    });
  },
);

test("an empty extends list runs only the Rules the config turns on", async () => {
  await withProject(async (root) => {
    const result = await runViteDoctor({
      root,
      framework: "vite",
      extensions: [extension],
      cache: false,
      config: {
        extends: [],
        overrides: [{ files: ["src/**"], rules: { "fixture/strict-only": "error" } }],
      },
    });
    expect(findings(result)).toEqual(["fixture/strict-only src/lib.ts error strict"]);
  });
});

test("cached results follow the override that applied", async () => {
  await withProject(async (root) => {
    const off: DoctorConfig = {
      overrides: [{ files: ["playground/**"], rules: { "fixture/every-file": "off" } }],
    };
    const lowered: DoctorConfig = {
      overrides: [{ files: ["playground/**"], rules: { "fixture/every-file": "info" } }],
    };
    expect(findings(await run(root, off, true))).toEqual(findings(await run(root, off, false)));
    const warm = await run(root, lowered, true);
    expect(findings(warm)).toEqual(findings(await run(root, lowered, false)));
    expect(findings(warm)).toContain("fixture/every-file playground/demo.ts info options:null");
    expect(findings(await run(root, off, true))).toEqual(findings(await run(root, off, false)));
  });
});

test("Nuxt manifest overrides apply before the explicit config's overrides", async () => {
  await withProject(async (root) => {
    mkdirSync(join(root, ".nuxt"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { nuxt: "^4.0.0" } }),
    );
    writeFileSync(
      join(root, ".nuxt/doctor.manifest.json"),
      JSON.stringify({
        doctorConfig: {
          overrides: [
            { files: ["src/**"], rules: { "fixture/every-file": "off" } },
            { files: ["playground/**"], rules: { "fixture/every-file": "info" } },
          ],
        },
      }),
    );
    const result = await runViteDoctor({
      root,
      extends: ["fixture/overrides/recommended"],
      extensions: [extension],
      cache: false,
      config: {
        include: ["src/**", "playground/**"],
        overrides: [{ files: ["src/**"], rules: { "fixture/every-file": "error" } }],
      },
    });
    expect(findings(result).filter((line) => line.startsWith("fixture/every-file"))).toEqual([
      "fixture/every-file playground/demo.ts info options:null",
      "fixture/every-file src/lib.ts error options:null",
    ]);
  });
});

test("the Nuxt module records overrides in the manifest", async () => {
  await withProject(async (root) => {
    const overrides = [
      { files: ["playground/**"], rules: { "fixture/every-file": "off" as const } },
    ];
    const nuxt = {
      _version: "4.5.1",
      options: { rootDir: root, buildDir: ".nuxt", modules: [] },
      async callHook() {},
    };
    await nuxtDoctorModule({ overrides }, nuxt as any);
    const manifest = await writeManifest(nuxt);
    expect(manifest.doctorConfig).toEqual({ overrides });
  });
});

test.each([
  [{ rules: { "fixture/every-file": "off" } }],
  [{ files: [], rules: {} }],
  [{ files: "src/**", rules: {} }],
  [{ files: ["src/**"], extends: ["auto"] }],
  [{ files: ["src/**"], extends: [42] }],
  [{ files: ["src/**"], rules: false }],
  [{ files: ["src/**"], rules: [] }],
  [[]],
])("a malformed override %j fails with DOC0035", async (override) => {
  await withProject(async (root) => {
    await expect(run(root, { overrides: [override as any] })).rejects.toMatchObject({
      name: "DOC0035",
    });
  });
});

test.each([null, false, { files: ["src/**"] }])(
  "a malformed override list %j fails with DOC0035",
  async (overrides) => {
    await withProject(async (root) => {
      await expect(run(root, { overrides: overrides as any })).rejects.toMatchObject({
        name: "DOC0035",
      });
    });
  },
);

test("an override with a malformed Rule config fails like the top-level config", async () => {
  await withProject(async (root) => {
    await expect(
      run(root, {
        overrides: [{ files: ["src/**"], rules: { "fixture/every-file": ["fatal" as any, {}] } }],
      }),
    ).rejects.toMatchObject({ name: "DOC0019" });
  });
});
