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
])("a malformed override %j fails with DOC0035", async (override) => {
  await withProject(async (root) => {
    await expect(run(root, { overrides: [override as any] })).rejects.toMatchObject({
      name: "DOC0035",
    });
  });
});

test("an override with a malformed Rule config fails like the top-level config", async () => {
  await withProject(async (root) => {
    await expect(
      run(root, {
        overrides: [{ files: ["src/**"], rules: { "fixture/every-file": ["fatal" as any, {}] } }],
      }),
    ).rejects.toMatchObject({ name: "DOC0019" });
  });
});
