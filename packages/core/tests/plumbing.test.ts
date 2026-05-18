import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  createJsonReport,
  createRulesReport,
  createSarifReport,
  createRule,
  createNuxtProjectInventory,
  allDiagnostics,
  defineDoctorExtension,
  defineRulePack,
  explainRule,
  runDoctor,
} from "../src/index.ts";
import { scoreDiagnostics } from "../src/internal/scoring.ts";

const reportProgramRule = createRule({
  meta: {
    id: "test/report-program",
    title: "Report program",
    category: "architecture",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: any) {
        if (node.type !== "Program") return;
        ctx.report(
          allDiagnostics.DOC9999.report({
            why: "Program was visited.",
            fix: "Inspect the test program diagnostic.",
          }),
          {
            ruleId: "test/report-program",
            severity: "warn",
            category: "architecture",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

const secondRule = createRule({
  meta: {
    id: "test/second-rule",
    title: "Second rule",
    category: "architecture",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: any) {
        if (node.type !== "Program") return;
        ctx.report(
          allDiagnostics.DOC9999.report({
            why: "Second rule was visited.",
            fix: "Inspect the second test diagnostic.",
          }),
          {
            ruleId: "test/second-rule",
            severity: "warn",
            category: "architecture",
            file: ctx.file.path,
          },
        );
      },
    };
  },
});

const duplicateRule = createRule({
  meta: {
    id: "test/duplicate-rule",
    title: "Duplicate rule",
    category: "architecture",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: any) {
        if (node.type !== "Program") return;
        for (let index = 0; index < 2; index++) {
          ctx.report(
            allDiagnostics.DOC9999.report({
              why: "Duplicate report.",
              fix: "Inspect the duplicate test diagnostic.",
            }),
            {
              ruleId: "test/duplicate-rule",
              severity: "warn",
              category: "architecture",
              file: ctx.file.path,
              range: ctx.range(node),
              fingerprint: "same-fingerprint",
            },
          );
        }
      },
    };
  },
});

const optionRule = createRule({
  meta: {
    id: "test/options-rule",
    title: "Options rule",
    category: "architecture",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: any) {
        if (node.type !== "Program") return;
        ctx.report(
          allDiagnostics.DOC9999.report({
            why: `option:${(ctx.options as any)?.mode ?? "missing"}`,
            fix: "Inspect the configured test option.",
          }),
          {
            ruleId: "test/options-rule",
            severity: ctx.severity,
            category: "architecture",
            file: ctx.file.path,
          },
        );
      },
    };
  },
});

test("Nuxt project inventory normalizes manifest scan roots", () => {
  const root = resolve("/fixture/project");
  const inventory = createNuxtProjectInventory(
    root,
    {
      nuxtVersion: "4.0.0",
      vueVersion: "3.5.0",
      rootDir: root,
      srcDir: root,
      appDir: "app",
      buildDir: ".nuxt",
      autoImports: [],
      components: [],
      layers: [],
      aliases: { "@": "app" },
      routeRules: {},
      serverHandlers: [{ file: "server/api/user.ts" }],
      modules: [],
      importsDirs: ["app/composables/custom"],
      pluginFiles: ["app/plugins/analytics.ts"],
      appScanRoots: ["app"],
      sharedScanRoots: ["shared/utils"],
      keyedComposables: ["useUser"],
      pages: [{ path: "/", file: "app/pages/index.vue" }],
      prerenderRoutes: ["/"],
      buildManifest: { hasBuildManifest: true, chunks: [] },
    },
    resolve(root, ".nuxt/doctor.manifest.json"),
  );

  expect(inventory.hasManifest).toBe(true);
  expect(inventory.importsDirs).toEqual([resolve(root, "app/composables/custom")]);
  expect(inventory.pluginFiles).toEqual([resolve(root, "app/plugins/analytics.ts")]);
  expect(inventory.evidence).toEqual({
    routeGraph: true,
    buildManifest: true,
    prerenderRoutes: 1,
    serverRoutes: 1,
  });
});

test("native glob selection excludes generated folders", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
      "dist/app.ts": "const ignored = true",
      "node_modules/pkg/index.ts": "const ignored = true",
      "public/browser.js": "window.alert('ignored')",
      "src/vendor.min.js": "window.alert('ignored')",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "vue",
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]!.file).toContain("src/app.ts");
    },
  );
});

test("native rule glob matching filters enabled rules", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const result = await runDoctor({
      root,
      framework: "vue",
      rules: "test/*program",
      extensions: [pluginWith(reportProgramRule, secondRule)],
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["test/report-program"]);
  });
});

test("diagnostics with identical fingerprints are reported once", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const result = await runDoctor({
      root,
      framework: "vue",
      extensions: [pluginWith(duplicateRule)],
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.summary.warn).toBe(1);
  });
});

test("rule config disables exact rule ids", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        config: { rules: { "test/report-program": "off" } },
        framework: "vue",
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("rule config applies severity strings and tuple options", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        config: { rules: { "test/options-rule": ["error", { mode: "strict" }] } },
        framework: "vue",
        extensions: [pluginWith(optionRule)],
      });

      expect(result.diagnostics[0]?.severity).toBe("error");
      expect(result.diagnostics[0]?.message).toBe("option:strict");
      expect(result.summary.error).toBe(1);
    },
  );
});

test("malformed rule config fails predictably", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
    },
    async (root) => {
      await expect(
        runDoctor({
          root,
          config: { rules: { "test/report-program": ["fatal" as any, {}] } },
          framework: "vue",
          extensions: [pluginWith(reportProgramRule)],
        }),
      ).rejects.toThrow(/Invalid severity/);
    },
  );
});

test("extends selection runs configured pack rules and config overrides extends", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        config: { rules: { "test/report-program": "error" } },
        extends: ["test/strict"],
        framework: "vue",
        extensions: [
          defineDoctorExtension({
            name: "test",
            rulePacks: [
              defineRulePack({
                name: "test",
                version: "0.0.0",
                rules: [reportProgramRule, secondRule],
                presets: {
                  recommended: ["test/second-rule"],
                  strict: ["test/report-program"],
                },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["test/report-program"]);
      expect(result.diagnostics[0]?.severity).toBe("error");
    },
  );
});

test("defineRulePack requires a recommended preset", () => {
  expect(() =>
    defineRulePack({
      name: "broken",
      version: "0.0.0",
      rules: [reportProgramRule],
      presets: {} as any,
    }),
  ).toThrow(/recommended preset/);
});

test("auto extends selects active recommended presets only", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "vue",
        extensions: [
          defineDoctorExtension({
            name: "test",
            rulePacks: [
              defineRulePack({
                name: "test/base",
                version: "0.0.0",
                rules: [reportProgramRule],
                presets: { recommended: ["test/report-program"] },
              }),
              defineRulePack({
                name: "test/inactive",
                version: "0.0.0",
                activation: { packages: ["missing-package"] },
                rules: [secondRule],
                presets: { recommended: ["test/second-rule"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["test/report-program"]);
    },
  );
});

test("explicit extends can select an inactive pack exactly", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "vue",
        extends: ["inactive/recommended"],
        extensions: [
          defineDoctorExtension({
            name: "test",
            rulePacks: [
              defineRulePack({
                name: "test/base",
                version: "0.0.0",
                rules: [reportProgramRule],
                presets: { recommended: ["test/report-program"] },
              }),
              defineRulePack({
                name: "test/inactive",
                version: "0.0.0",
                activation: { packages: ["missing-package"] },
                rules: [secondRule],
                presets: { recommended: ["test/second-rule"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["test/second-rule"]);
    },
  );
});

test("severity filters use final configured severity", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        config: { rules: { "test/report-program": "error" } },
        severity: "error",
        framework: "vue",
        extensions: [pluginWith(reportProgramRule, secondRule)],
      });
      const sarif = JSON.parse(createSarifReport(result));

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["test/report-program"]);
      expect(result.summary.error).toBe(1);
      expect(sarif.runs[0].results[0].level).toBe("error");
    },
  );
});

test("json reporter produces stable machine output", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const result = await runDoctor({
      root,
      framework: "vue",
      extensions: [pluginWith(reportProgramRule)],
    });
    const json = JSON.parse(createJsonReport(result));

    expect(json.diagnostics[0].ruleId).toBe("test/report-program");
    expect(json.summary.warn).toBe(1);
  });
});

test("health score is not exhausted by warnings alone", async () => {
  await withFixture(
    Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`src/app${index}.ts`, "const ok = true"]),
    ),
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "vue",
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(result.summary.warn).toBe(20);
      expect(result.summary.blocker).toBe(0);
      expect(result.summary.error).toBe(0);
      expect(result.score).toBeGreaterThan(0);
    },
  );
});

test("diagnostic scoring preserves overall and category penalties", () => {
  const diagnostics = [
    diagnostic("blocker", "architecture", "safe"),
    diagnostic("error", "architecture"),
    diagnostic("warn", "architecture"),
    diagnostic("warn", "routing"),
    diagnostic("info", "routing"),
  ];
  const scoring = scoreDiagnostics(diagnostics, {});

  expect(scoring.summary).toEqual({
    blocker: 1,
    error: 1,
    warn: 2,
    info: 1,
    fixable: 1,
  });
  expect(scoring.score).toBe(70);
  expect(scoring.categoryScores).toEqual({
    architecture: 74,
    routing: 96,
  });
});

test("sarif reporter includes partial fingerprints", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const result = await runDoctor({
      root,
      framework: "vue",
      extensions: [pluginWith(reportProgramRule)],
    });
    const sarif = JSON.parse(createSarifReport(result));

    expect(sarif.runs[0].results[0].partialFingerprints["vue-doctor/v1"]).toBeTruthy();
    expect(sarif.runs[0].results[0].ruleId).toBe("test/report-program");
  });
});

test("baseline new-only suppresses existing diagnostics", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const first = await runDoctor({
      root,
      framework: "vue",
      baseline: "doctor-baseline.json",
      updateBaseline: true,
      extensions: [pluginWith(reportProgramRule)],
    });
    const second = await runDoctor({
      root,
      framework: "vue",
      baseline: "doctor-baseline.json",
      newOnly: true,
      extensions: [pluginWith(reportProgramRule)],
    });

    expect(first.diagnostics).toHaveLength(1);
    expect(second.diagnostics).toHaveLength(0);
    expect(second.suppressedDiagnostics).toHaveLength(1);
  });
});

test("rules and explain reports expose rule metadata as json", () => {
  const pack = defineRulePack({
    name: "test",
    version: "0.0.0",
    rules: [reportProgramRule],
    presets: { recommended: ["test/report-program"] },
  });
  const rules = JSON.parse(createRulesReport([pack], "json"));
  const explain = JSON.parse(explainRule([pack], "test/report-program", "json"));

  expect(rules.rules[0].id).toBe("test/report-program");
  expect(explain.id).toBe("test/report-program");
});

test("runDoctor does not load repository-local config by default", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
      "doctor.config.ts": maliciousConfigSource("default-marker"),
    },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "vue",
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics.some((item) => item.file.endsWith("src/app.ts"))).toBe(true);
      expect(existsSync(join(root, "default-marker"))).toBe(false);
    },
  );
});

test("runDoctor accepts an already-loaded config object", async () => {
  await withFixture(
    {
      "src/app.ts": "const ignored = true",
      "doctor.config.ts": maliciousConfigSource("trusted-marker"),
    },
    async (root) => {
      const result = await runDoctor({
        root,
        config: { exclude: ["src/**", "doctor.config.*"] },
        framework: "vue",
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics).toHaveLength(0);
      expect(existsSync(join(root, "trusted-marker"))).toBe(false);
    },
  );
});

async function withFixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vue-doctor-core-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
    );
    for (const [file, text] of Object.entries(files)) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function maliciousConfigSource(marker: string) {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./${marker}", import.meta.url), "executed");\n`;
}

function diagnostic(severity: string, category: string, fixKind?: string) {
  return {
    ruleId: `test/${severity}-${category}`,
    severity,
    category,
    file: "src/app.ts",
    message: "Diagnostic",
    fix: fixKind ? { kind: fixKind, edits: [] } : undefined,
  } as any;
}

function pluginWith(...rules: any[]) {
  return defineDoctorExtension({
    name: "test",
    rulePacks: [
      defineRulePack({
        name: "test",
        version: "0.0.0",
        rules,
        presets: { recommended: rules.map((rule) => rule.meta.id) },
      }),
    ],
  });
}
