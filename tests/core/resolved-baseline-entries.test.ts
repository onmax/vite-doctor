import { expect, test } from "vite-plus/test";
import { FINGERPRINT_SCHEME } from "../../src/core/diagnostic-constants.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noClientSecretPattern } from "../../src/rules.ts";
import type { DoctorConfig, DoctorRunOptions } from "../../src/core/config.ts";

const leaking = "console.log(import.meta.env.VITE_SECRET)\n";
const fixed = 'console.log("ready")\n';
const ruleId = "vite/env/no-client-secret-pattern";

async function recordedFinding() {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": leaking },
  });
  return result.diagnostics[0]!;
}

function baselineJson(entries: object[]) {
  return JSON.stringify({
    version: 2,
    fingerprintScheme: FINGERPRINT_SCHEME,
    diagnostics: entries,
  });
}

async function runAgainst(
  entries: object[],
  options: {
    files?: Record<string, string>;
    config?: DoctorConfig;
    run?: Partial<DoctorRunOptions>;
  } = {},
) {
  return runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: {
      "src/main.ts": fixed,
      ...options.files,
      "baseline.json": baselineJson(entries),
    },
    config: options.config,
    run: { baseline: "baseline.json", newOnly: true, ...options.run },
  });
}

const resolvedEntries = (diagnostics: { code: string }[]) =>
  diagnostics.filter((diagnostic) => diagnostic.code === "DOC0039");

test("a full run reports a recorded finding it no longer reports as DOC0039", async () => {
  const finding = await recordedFinding();
  const result = await runAgainst([
    { ruleId, file: "src/main.ts", fingerprint: finding.fingerprint },
  ]);

  expect(result.diagnostics).toMatchObject([
    {
      code: "DOC0039",
      ruleId: "doctor/baseline/resolved-entries",
      severity: "info",
      file: expect.stringMatching(/baseline\.json$/),
      evidence: [
        {
          kind: "manifest",
          summary: `${ruleId} no longer reports fingerprint ${finding.fingerprint} in src/main.ts.`,
          file: expect.stringMatching(/src\/main\.ts$/),
        },
      ],
    },
  ]);
  expect(result.diagnostics[0]!.why).toContain("records 1 finding that");
  expect(result.diagnostics[0]!.suggestion).toContain("--baseline baseline.json --update-baseline");
});

test("a recorded finding that still exists is not reported", async () => {
  const finding = await recordedFinding();
  const result = await runAgainst(
    [{ ruleId, file: "src/main.ts", fingerprint: finding.fingerprint }],
    {
      files: { "src/main.ts": leaking },
    },
  );

  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ fingerprint: finding.fingerprint }]);
});

test("an entry whose file no longer exists is resolved", async () => {
  const result = await runAgainst([{ ruleId, file: "src/removed.ts", fingerprint: "gone" }]);

  expect(resolvedEntries(result.diagnostics)).toHaveLength(1);
});

test.each<[string, object]>([
  ["has no Rule ID", { file: "src/main.ts", fingerprint: "unknown" }],
  ["has no file", { ruleId, fingerprint: "unknown" }],
  [
    "belongs to a Rule that did not run",
    { ruleId: "vite/other/rule", file: "src/main.ts", fingerprint: "unknown" },
  ],
  [
    "comes from a workspace analysis",
    { ruleId: "workspace/dead-code/unused-file", file: "src/main.ts", fingerprint: "unknown" },
  ],
])("an entry that %s is not proven resolved", async (_name, entry) => {
  const result = await runAgainst([entry]);

  expect(resolvedEntries(result.diagnostics)).toEqual([]);
});

test("an entry for an existing file Doctor did not analyze is not proven resolved", async () => {
  const result = await runAgainst([{ ruleId, file: "src/skipped.ts", fingerprint: "unknown" }], {
    files: { "src/skipped.ts": leaking },
    config: { exclude: ["src/skipped.ts"] },
  });

  expect(resolvedEntries(result.diagnostics)).toEqual([]);
});

test.each<[string, Partial<DoctorRunOptions>]>([
  ["a Rule selection", { rules: ruleId }],
  ["an affected-file run", { affectedFiles: ["src/main.ts"] }],
  ["an error severity threshold", { severity: "error" }],
  ["a baseline update", { updateBaseline: true }],
])("%s never reports DOC0039", async (_name, run) => {
  const result = await runAgainst([{ ruleId, file: "src/removed.ts", fingerprint: "gone" }], {
    run,
  });

  expect(resolvedEntries(result.diagnostics)).toEqual([]);
});

test("a config suppression hides DOC0039", async () => {
  const result = await runAgainst([{ ruleId, file: "src/removed.ts", fingerprint: "gone" }], {
    config: {
      suppressions: [
        { ruleId: "doctor/baseline/resolved-entries", reason: "Pruned in the release PR." },
      ],
    },
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { code: "DOC0039", suppressionReason: "Pruned in the release PR." },
  ]);
});

test("a baseline from another fingerprint scheme reports DOC0032 instead", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: {
      "src/main.ts": fixed,
      "baseline.json": JSON.stringify({
        version: 2,
        fingerprintScheme: FINGERPRINT_SCHEME - 1,
        diagnostics: [{ ruleId, file: "src/removed.ts", fingerprint: "gone" }],
      }),
    },
    run: { baseline: "baseline.json", newOnly: true },
  });

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["DOC0032"]);
});
