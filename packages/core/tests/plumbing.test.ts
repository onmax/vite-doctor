import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  createJsonReport,
  createRulesReport,
  createSarifReport,
  createRule,
  defineDoctorPlugin,
  explainRule,
  runDoctor,
} from "../src/index.ts";

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
        ctx.report({
          ruleId: "test/report-program",
          severity: "warn",
          category: "architecture",
          file: ctx.file.path,
          range: ctx.range(node),
          message: "Program was visited.",
        });
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
        ctx.report({
          ruleId: "test/second-rule",
          severity: "warn",
          category: "architecture",
          file: ctx.file.path,
          message: "Second rule was visited.",
        });
      },
    };
  },
});

test("native glob selection excludes generated folders", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
      "dist/app.ts": "const ignored = true",
      "node_modules/pkg/index.ts": "const ignored = true",
    },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "vue",
        plugins: [pluginWith(reportProgramRule)],
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
      plugins: [pluginWith(reportProgramRule, secondRule)],
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual(["test/report-program"]);
  });
});

test("json reporter produces stable machine output", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const result = await runDoctor({
      root,
      framework: "vue",
      plugins: [pluginWith(reportProgramRule)],
    });
    const json = JSON.parse(createJsonReport(result));

    expect(json.diagnostics[0].ruleId).toBe("test/report-program");
    expect(json.summary.warn).toBe(1);
  });
});

test("sarif reporter includes partial fingerprints", async () => {
  await withFixture({ "src/app.ts": "const ok = true" }, async (root) => {
    const result = await runDoctor({
      root,
      framework: "vue",
      plugins: [pluginWith(reportProgramRule)],
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
      plugins: [pluginWith(reportProgramRule)],
    });
    const second = await runDoctor({
      root,
      framework: "vue",
      baseline: "doctor-baseline.json",
      newOnly: true,
      plugins: [pluginWith(reportProgramRule)],
    });

    expect(first.diagnostics).toHaveLength(1);
    expect(second.diagnostics).toHaveLength(0);
    expect(second.suppressedDiagnostics).toHaveLength(1);
  });
});

test("rules and explain reports expose rule metadata as json", () => {
  const pack = { name: "test", version: "0.0.0", rules: [reportProgramRule] };
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
        plugins: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics.some((item) => item.file.endsWith("src/app.ts"))).toBe(true);
      expect(existsSync(join(root, "default-marker"))).toBe(false);
    },
  );
});

test("trusted runDoctor config opt-in loads local config", async () => {
  await withFixture(
    {
      "src/app.ts": "const ignored = true",
      "doctor.config.ts": `${maliciousConfigSource("trusted-marker")}\nexport default { exclude: ["src/**", "doctor.config.*"] }\n`,
    },
    async (root) => {
      const result = await runDoctor({
        root,
        config: true,
        framework: "vue",
        plugins: [pluginWith(reportProgramRule)],
      });

      expect(result.diagnostics).toHaveLength(0);
      expect(existsSync(join(root, "trusted-marker"))).toBe(true);
    },
  );
});

test("CLI scan does not load repository-local config by default", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
      "doctor.config.ts": maliciousConfigSource("cli-default-marker"),
    },
    async (root) => {
      const cli = resolve(process.cwd(), "../vue/dist/cli.mjs");
      const result = await runCli(cli, ["scan", root, "--format", "text"]);

      expect(result.code).toBe(0);
      expect(existsSync(join(root, "cli-default-marker"))).toBe(false);
    },
  );
});

test("CLI trusted config opt-in loads local config", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
      "doctor.config.ts": `${maliciousConfigSource("cli-trusted-marker")}\nexport default {}\n`,
    },
    async (root) => {
      const cli = resolve(process.cwd(), "../vue/dist/cli.mjs");
      const result = await runCli(cli, ["scan", root, "--format", "text", "--trusted-config"]);

      expect(result.code).toBe(0);
      expect(existsSync(join(root, "cli-trusted-marker"))).toBe(true);
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

const execFileAsync = promisify(execFile);

async function runCli(cli: string, args: string[]) {
  try {
    await execFileAsync("node", [cli, ...args]);
    return { code: 0 };
  } catch (error: any) {
    return { code: error.code ?? 1 };
  }
}

function maliciousConfigSource(marker: string) {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./${marker}", import.meta.url), "executed");\n`;
}

function pluginWith(...rules: any[]) {
  return defineDoctorPlugin({
    name: "test",
    rulePacks: [{ name: "test", version: "0.0.0", rules }],
  });
}
