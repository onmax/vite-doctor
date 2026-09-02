import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  createJsonReport,
  createAgentReport,
  createRulesReport,
  createSarifReport,
  createRule,
  createNuxtProjectInventory,
  allDiagnostics,
  createDoctorDiagnosticsHost,
  defineDoctorDiagnostics,
  defineDoctorExtension,
  defineRulePack,
  explainRule,
  runDoctor,
} from "../../src/core/index.ts";
import {
  normalizeDiagnostic,
  normalizeDiagnosticFromRuleCode,
} from "../../src/core/internal/diagnostics.ts";
import { scoreDiagnostics } from "../../src/core/internal/scoring.ts";
import { getNodeVisitorKeys } from "../../src/core/internal/visitor-keys.ts";

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
          allDiagnostics.DOC9999({
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

const safeFixRule = createRule({
  meta: {
    id: "test/safe-fix",
    title: "Safe fix",
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
            ruleId: "test/safe-fix",
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

const reportIdentifiersRule = createRule({
  meta: {
    id: "test/report-identifiers",
    title: "Report identifiers",
    category: "architecture",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: any) {
        if (node.type !== "Identifier") return;
        ctx.report(
          allDiagnostics.DOC9999({
            why: `Identifier ${node.name} was visited.`,
            fix: "Inspect the test identifier diagnostic.",
          }),
          {
            ruleId: "test/report-identifiers",
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

test("visitor keys fall back to node-shaped children", () => {
  expect(
    getNodeVisitorKeys({
      type: "FixtureNode",
      child: { type: "ChildNode" },
      children: [{ type: "NestedNode" }],
      start: 0,
      end: 1,
    }),
  ).toEqual(["child", "children"]);
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
          allDiagnostics.DOC9999({
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
            allDiagnostics.DOC9999({
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
          allDiagnostics.DOC9999({
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

const missingFixRule = createRule({
  meta: {
    id: "test/missing-fix-rule",
    title: "Missing fix rule",
    category: "architecture",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: any) {
        if (node.type !== "Program") return;
        ctx.report((allDiagnostics.DOC9999 as any)({ why: "Missing fix." }), {
          ruleId: "test/missing-fix-rule",
          severity: "warn",
          category: "architecture",
          file: ctx.file.path,
        });
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

test("native glob selection excludes generated files and folders", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
      "dist/app.ts": "const ignored = true",
      "node_modules/pkg/index.ts": "const ignored = true",
      "public/browser.js": "window.alert('ignored')",
      "src/api.generated.ts": "const ignored = true",
      "src/api-generated.ts": "const included = true",
      "src/generated-header.ts":
        "// This file is auto-generated. Do not edit.\nconst ignored = true",
      "src/generation-helper.ts": "const generatedOutput = true",
      "src/vendor.min.js": "window.alert('ignored')",
      "src/vendor.min.jsx": "window.alert('ignored')",
      "src/example.test.mts": "const ignored: object = {}",
      "src/example.spec.cts": "const ignored: object = {}",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "vue",
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics.map((item) => item.file).sort()).toEqual(
        [
          join(root, "src/api-generated.ts"),
          join(root, "src/app.ts"),
          join(root, "src/generation-helper.ts"),
        ].sort(),
      );
    },
  );
});

test("native glob selection excludes exact type-test directory names", async () => {
  await withFixture(
    {
      "node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.0" }),
      "src/app.ts": "const app = true",
      "src/snapshot-helper.ts": "const helper = true",
      "src/test-d-helper.ts": "const helper = true",
      "src/type-tests-helper.ts": "const helper = true",
      "src/typetest-helper.ts": "const helper = true",
      "src/dts-test-helper.ts": "const helper = true",
      "src/dtslint-helper.ts": "const helper = true",
      "__snapshots__/assertions.ts": "const ignored: object = {}",
      "test-d/assertions.ts": "const ignored: object = {}",
      "type-tests/assertions.ts": "const ignored: object = {}",
      "typetest/assertions.ts": "const ignored: object = {}",
      "__typetest__/assertions.ts": "const ignored: object = {}",
      "dts-test/assertions.ts": "const ignored: object = {}",
      "dtslint/assertions.ts": "const ignored: object = {}",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "vue",
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics.map((item) => item.file).sort()).toEqual(
        [
          join(root, "src/app.ts"),
          join(root, "src/dts-test-helper.ts"),
          join(root, "src/dtslint-helper.ts"),
          join(root, "src/snapshot-helper.ts"),
          join(root, "src/test-d-helper.ts"),
          join(root, "src/type-tests-helper.ts"),
          join(root, "src/typetest-helper.ts"),
        ].sort(),
      );
    },
  );
});

test("language activation recognizes JavaScript in Vue SFCs", async () => {
  await withFixture(
    {
      "app.vue": "<script setup>const ok = true</script>",
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
                name: "test/javascript",
                version: "0.0.0",
                activation: { languages: ["javascript"] },
                rules: [reportProgramRule],
                presets: { recommended: [reportProgramRule.meta.id] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["test/report-program"]);
    },
  );
});

test("since scans only files changed from the requested Git ref", async () => {
  await withFixture(
    {
      "src/changed.ts": "const changed = true",
      "src/generated.ts": "// @generated\nconst generated = true",
      "src/unchanged.ts": "const unchanged = true",
    },
    async (root) => {
      git(root, "init");
      git(root, "add", ".");
      git(
        root,
        "-c",
        "user.name=Doctor",
        "-c",
        "user.email=doctor@example.com",
        "commit",
        "-m",
        "fixture",
      );
      writeFileSync(join(root, "src/changed.ts"), "const changed = false");
      writeFileSync(join(root, "src/generated.ts"), "// @generated\nconst generated = false");

      const result = await runDoctor({
        root,
        since: "HEAD",
        framework: "vue",
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]!.file).toContain("src/changed.ts");
    },
  );
});

test("since scans no files when the requested Git diff is empty", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    git(root, "init");
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=Doctor",
      "-c",
      "user.email=doctor@example.com",
      "commit",
      "-m",
      "fixture",
    );

    const result = await runDoctor({
      root,
      since: "HEAD",
      framework: "vue",
      extensions: [pluginWith(reportProgramRule)],
    });

    expect(result.diagnostics).toHaveLength(0);
  });
});

test("changed scope reports diagnostics whose source ranges overlap changed lines", async () => {
  await withFixture({ "src/app.ts": "const first = true\nconst second = true\n" }, async (root) => {
    git(root, "init");
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=Doctor",
      "-c",
      "user.email=doctor@example.com",
      "commit",
      "-m",
      "fixture",
    );
    writeFileSync(join(root, "src/app.ts"), "const first = true\nconst second = false\n");

    const result = await runDoctor({
      root,
      changed: true,
      framework: "vue",
      extensions: [pluginWith(reportIdentifiersRule, reportProgramRule, secondRule)],
    });

    expect(result.scope).toMatchObject({ mode: "changed", files: 1 });
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "test/report-identifiers",
          why: "Identifier second was visited.",
          range: expect.objectContaining({ line: 2 }),
        }),
        expect.objectContaining({ ruleId: "test/report-program" }),
      ]),
    );
  });
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
      ).rejects.toMatchObject({ name: "DOC0019" });
    },
  );
});

test("internal diagnostic guards use stable codes", async () => {
  const registry = defineDoctorDiagnostics([
    { code: "DOC9001", ruleId: "test/duplicate-a" },
    { code: "DOC9001", ruleId: "test/duplicate-b" },
  ]);
  const host = createDoctorDiagnosticsHost();
  host.register(registry);
  expect(thrownBy(() => host.register(registry))).toMatchObject({ name: "DOC0012" });

  expect(
    thrownBy(() =>
      normalizeDiagnosticFromRuleCode({
        ruleId: "test/missing-code",
        code: "DOC4040",
        severity: "warn",
        category: "architecture",
        file: "src/app.ts",
        suggestion: "Register the missing diagnostic code.",
      }),
    ),
  ).toMatchObject({ name: "DOC0013" });

  expect(
    thrownBy(() =>
      normalizeDiagnostic({
        diagnostic: { why: "Missing nostics code.", fix: "Use a registered handle." } as any,
        ruleId: "test/missing-name",
        severity: "warn",
        category: "architecture",
        file: "src/app.ts",
      }),
    ),
  ).toMatchObject({ name: "DOC0014" });
});

test("configuration validation failures use stable diagnostic codes", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const extension = pluginWith(reportProgramRule);

    await expect(
      runDoctor({
        root,
        framework: "vue",
        extends: ["broken"],
        extensions: [extension],
      }),
    ).rejects.toMatchObject({ name: "DOC0016" });

    await expect(
      runDoctor({
        root,
        framework: "vue",
        extends: ["missing/recommended"],
        extensions: [extension],
      }),
    ).rejects.toMatchObject({ name: "DOC0017" });

    await expect(
      runDoctor({
        root,
        framework: "vue",
        extends: ["test/missing"],
        extensions: [extension],
      }),
    ).rejects.toMatchObject({ name: "DOC0018" });

    await expect(
      runDoctor({
        root,
        config: { rules: { "test/report-program": ["fatal" as any, {}] } },
        framework: "vue",
        extensions: [extension],
      }),
    ).rejects.toMatchObject({ name: "DOC0019" });

    await expect(
      runDoctor({
        root,
        config: { rules: { "test/report-program": { severity: "warn" } as any } },
        framework: "vue",
        extensions: [extension],
      }),
    ).rejects.toMatchObject({ name: "DOC0020" });
  });
});

test("rule diagnostics must include actionable fix text", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    await expect(
      runDoctor({
        root,
        framework: "vue",
        extensions: [pluginWith(missingFixRule)],
      }),
    ).rejects.toMatchObject({ name: "DOC0021" });
  });
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
  let thrown: unknown;
  try {
    defineRulePack({
      name: "broken",
      version: "0.0.0",
      rules: [reportProgramRule],
      presets: {} as any,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ name: "DOC0015" });
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/recommended preset/);
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

    expect(json.diagnostics[0].rule).toBe("test/report-program");
    expect(json.diagnostics[0].location.path).toBe("src/app.ts");
    expect(json.summary.warn).toBe(1);
  });
});

test("agent reporter is compact and includes a complete remediation path", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const result = await runDoctor({
      root,
      framework: "vue",
      extensions: [pluginWith(reportProgramRule)],
    });
    const report = createAgentReport(result);
    const agent = JSON.parse(report);

    expect(agent.schema).toBe("vite-doctor.agent/v1");
    expect(agent.diagnostics[0]).toMatchObject({
      rule: "test/report-program",
      location: { path: "src/app.ts" },
      remediation: "Inspect the test program diagnostic.",
    });
    expect(agent.commands).toEqual({
      explain: "vite-doctor explain <code> --format agent",
      verify: "vite-doctor . --rules <rule> --format agent",
      rerun: "vite-doctor . --format agent",
    });
    expect(report).not.toContain(join(root, "src/app.ts"));
  });
});

test("safe fixes are rerun and the report contains only remaining diagnostics", async () => {
  await withFixture({ "src/app.ts": "const bad = true\n" }, async (root) => {
    const result = await runDoctor({
      root,
      framework: "vue",
      fix: true,
      cache: false,
      baseline: "doctor-baseline.json",
      updateBaseline: true,
      extensions: [pluginWith(safeFixRule)],
    });

    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toBe("const good = true\n");
    expect(result.diagnostics).toHaveLength(0);
    expect(result.fixes).toEqual({ files: 1, edits: 1, skipped: 0 });
    expect(
      JSON.parse(readFileSync(join(root, "doctor-baseline.json"), "utf8")).diagnostics,
    ).toEqual([]);
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

    expect(sarif.runs[0].results[0].partialFingerprints["vite-doctor/v1"]).toBeTruthy();
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

test("persistent cache defaults to Vite Doctor directory", async () => {
  await withFixture(
    {
      "src/app.ts": "const message = 'hello'\n",
    },
    async (root) => {
      await runDoctor({
        root,
        framework: "vue",
        cache: true,
        extensions: [pluginWith(reportProgramRule)],
      });

      expect(existsSync(join(root, ".vite-doctor/cache"))).toBe(true);
      expect(existsSync(join(root, ".vue-doctor"))).toBe(false);
    },
  );
});

function thrownBy(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected function to throw.");
}

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

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
