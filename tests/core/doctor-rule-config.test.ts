import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  createRule,
  defineDoctorDiagnostics,
  defineDoctorExtension,
  defineRulePack,
  runDoctor,
} from "../../src/core/index.ts";
import type { Diagnostic, DoctorConfig, DoctorRunOptions } from "../../src/core/index.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noClientSecretPattern } from "../../src/rules.ts";

const secret = noClientSecretPattern.meta.id;
const rules = [noClientSecretPattern];
const staleDirective = `// doctor-disable-next-line ${secret} -- The secret moved server-side.\nconsole.log(1);\n`;

const reported = (diagnostics: Diagnostic[], code: string) =>
  diagnostics
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => ({
      severity: diagnostic.severity,
      file: diagnostic.file.slice(diagnostic.file.indexOf("/src/") + 1),
    }));

const cases = [
  ["doctor/inline/unused-suppression", "DOC0036", { "src/main.ts": staleDirective }, {}],
  [
    "doctor/inline/unknown-suppression-rule",
    "DOC0037",
    {
      "src/main.ts":
        "// doctor-disable-next-line vite/env/no-such-rule -- Typo.\nconsole.log(1);\n",
    },
    {},
  ],
  ["doctor/inventory/empty-sfc", "DOC0033", { "src/Empty.vue": "" }, {}],
  [
    "doctor/config/unused-suppression",
    "DOC0031",
    { "src/main.ts": "console.log(1);\n" },
    { suppressions: [{ ruleId: secret, file: "src/main.ts", reason: "Moved server-side." }] },
  ],
] as const satisfies ReadonlyArray<readonly [string, string, Record<string, string>, DoctorConfig]>;

test.each(cases)("a severity in rules applies to %s", async (ruleId, code, files, config) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files,
    config: { ...config, rules: { [ruleId]: "error" } },
  });
  expect(reported(result.diagnostics, code)).toMatchObject([{ severity: "error" }]);
});

test.each(cases)("off in rules turns off %s", async (ruleId, code, files, config) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files,
    config: { ...config, rules: { [ruleId]: "off" } },
  });
  expect(reported(result.diagnostics, code)).toEqual([]);
});

test("overrides set the severity of DOC0036 per path", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": staleDirective,
      "src/legacy/old.ts": staleDirective,
      "src/legacy/kept/new.ts": staleDirective,
    },
    config: {
      rules: { "doctor/inline/unused-suppression": "error" },
      overrides: [
        { files: ["src/legacy/**"], rules: { "doctor/inline/unused-suppression": "off" } },
        { files: ["src/legacy/kept/**"], rules: { "doctor/inline/unused-suppression": "warn" } },
      ],
    },
  });
  expect(
    reported(result.diagnostics, "DOC0036").sort((a, b) => a.file.localeCompare(b.file)),
  ).toEqual([
    { severity: "warn", file: "src/legacy/kept/new.ts" },
    { severity: "error", file: "src/main.ts" },
  ]);
});

test("a configured severity decides whether DOC0036 passes the severity threshold", async () => {
  const run = (severity: "error" | "warn") =>
    runProjectFixture({
      framework: "vite",
      rules,
      files: { "src/main.ts": staleDirective },
      config: { rules: { "doctor/inline/unused-suppression": severity } },
      run: { severity: "error" },
    });
  expect(reported((await run("error")).diagnostics, "DOC0036")).toMatchObject([
    { severity: "error" },
  ]);
  expect(reported((await run("warn")).diagnostics, "DOC0036")).toEqual([]);
});

const unusedRuleId = "doctor/inline/unused-suppression";
const unknownRuleId = "doctor/inline/unknown-suppression-rule";
const unknownTarget = "vite/env/no-such-rule";
const mixedTargets = `${secret},${unknownTarget}`;

interface InlineFixCase {
  settings: NonNullable<DoctorConfig["rules"]>;
  minimum?: DoctorRunOptions["severity"];
  ids: string;
  kept: string;
  edits: number;
}

test.each<InlineFixCase>([
  { settings: { [unusedRuleId]: "off" }, ids: secret, kept: secret, edits: 0 },
  { settings: { [unusedRuleId]: "off" }, ids: mixedTargets, kept: secret, edits: 1 },
  {
    settings: { [unknownRuleId]: "off" },
    ids: mixedTargets,
    kept: unknownTarget,
    edits: 1,
  },
  {
    settings: { [unusedRuleId]: "warn", [unknownRuleId]: "error" },
    minimum: "error",
    ids: mixedTargets,
    kept: secret,
    edits: 1,
  },
  { settings: {}, ids: mixedTargets, kept: "", edits: 1 },
])(
  "--fix preserves ineligible IDs with settings $settings and IDs $ids",
  async ({ settings, minimum, ids, kept, edits }) => {
    const root = mkdtempSync(join(tmpdir(), "doctor-rule-config-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      mkdirSync(join(root, "src"));
      const source = (ruleIds: string) =>
        `${ruleIds ? `// doctor-disable-next-line ${ruleIds} -- Old.\n` : ""}console.log(1);\n`;
      writeFileSync(join(root, "src/main.ts"), source(ids));
      const result = await runDoctor({
        root,
        framework: "vite",
        cache: false,
        fix: true,
        severity: minimum,
        config: { rules: settings },
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules,
                presets: { recommended: [secret] },
              }),
            ],
          }),
        ],
      });
      expect(readFileSync(join(root, "src/main.ts"), "utf8")).toBe(source(kept));
      expect(result.fixes?.edits ?? 0).toBe(edits);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([
  [{}, "info"],
  [{ rules: { "doctor/inline/unused-suppression": "off" } }, "info"],
  [
    {
      overrides: [
        { files: ["doctor.config.json"], rules: { "doctor/config/unused-suppression": "error" } },
      ],
    },
    "error",
  ],
  [{ rules: { [secret]: "off" } }, undefined],
  [{ overrides: [{ files: ["src/**"], rules: { [secret]: "off" } }] }, undefined],
] satisfies Array<[DoctorConfig, Diagnostic["severity"] | undefined]>)(
  "a broad suppression considers actual coverage with config %j",
  async (settings, severity) => {
    const config = { ...settings, suppressions: [{ file: "src/main.ts", reason: "Old." }] };
    const result = await runProjectFixture({
      framework: "vite",
      rules,
      files: { "src/main.ts": "console.log(1);\n", "doctor.config.json": JSON.stringify(config) },
      run: { config },
    });
    expect(reported(result.diagnostics, "DOC0031").map((item) => item.severity)).toEqual(
      severity ? [severity] : [],
    );
  },
);

test("registered extension Rules in the doctor namespace take normal settings", async () => {
  const ruleId = "doctor/project/no-legacy";
  const registry = defineDoctorDiagnostics([{ code: "ACME0001", ruleId }]);
  const rule = createRule({
    meta: { id: ruleId, title: "No legacy imports", category: "project", severity: "info" },
    create(ctx) {
      return {
        ImportDeclaration(node) {
          ctx.report(registry.diagnostics.ACME0001({ why: "Legacy import.", fix: "Replace it." }), {
            range: ctx.range(node),
          });
        },
      };
    },
  });
  const run = (config: DoctorConfig) =>
    runProjectFixture({
      framework: "vite",
      rules: [rule],
      files: { "src/main.ts": 'import "./legacy";\n' },
      config,
    });
  expect(reported((await run({})).diagnostics, "ACME0001")).toMatchObject([{ severity: "info" }]);
  expect(reported((await run({ rules: { [ruleId]: "off" } })).diagnostics, "ACME0001")).toEqual([]);
  expect(
    reported(
      (await run({ overrides: [{ files: ["src/**"], rules: { [ruleId]: "error" } }] })).diagnostics,
      "ACME0001",
    ),
  ).toMatchObject([{ severity: "error" }]);
});

async function runWithStaleBaseline(config: DoctorConfig) {
  const files = { "src/main.ts": "console.log(import.meta.env.VITE_SECRET)\n" };
  const initial = await runProjectFixture({ framework: "vite", rules, files });
  return runProjectFixture({
    framework: "vite",
    rules,
    files: {
      ...files,
      "baseline.json": JSON.stringify({
        version: 1,
        diagnostics: [{ fingerprint: initial.diagnostics[0]!.fingerprint }],
      }),
    },
    config,
    run: { baseline: "baseline.json", newOnly: true },
  });
}

test("rules set the severity of DOC0032 or turn it off", async () => {
  const ruleId = "doctor/baseline/stale-fingerprint-scheme";
  const raised = await runWithStaleBaseline({ rules: { [ruleId]: "error" } });
  expect(raised.diagnostics).toMatchObject([{ code: "DOC0032", severity: "error" }]);
  const off = await runWithStaleBaseline({ rules: { [ruleId]: "off" } });
  expect(off.diagnostics).toEqual([]);
});

test.each([
  ["a Doctor error that is thrown, not reported", "doctor/config/invalid-rule-severity", "off"],
  ["a misspelled Doctor Rule ID", "doctor/inline/unused-suppresion", "error"],
  ["the fallback Rule ID of external Diagnostics", "doctor/external-rule-diagnostic", "off"],
  ["options for a Doctor Rule", "doctor/inline/unused-suppression", ["error", { strict: true }]],
] as const)("config naming %s fails", async (_, ruleId, value) => {
  for (const config of [
    { rules: { [ruleId]: value } },
    { overrides: [{ files: ["src/**"], rules: { [ruleId]: value } }] },
  ] as DoctorConfig[])
    await expect(
      runProjectFixture({ framework: "vite", rules, files: { "src/main.ts": "" }, config }),
    ).rejects.toMatchObject({ name: "DOC0020", message: expect.stringContaining(ruleId) });
});
