import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { defineDoctorExtension, defineRulePack, runDoctor } from "../../src/core/index.ts";
import type { Diagnostic, DoctorConfig } from "../../src/core/index.ts";
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

test("off for DOC0036 keeps --fix from deleting the directive", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-rule-config-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.ts"), staleDirective);
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      fix: true,
      config: { rules: { "doctor/inline/unused-suppression": "off" } },
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
    expect(result.fixes?.edits ?? 0).toBe(0);
    expect(readFileSync(join(root, "src/main.ts"), "utf8")).toBe(staleDirective);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
