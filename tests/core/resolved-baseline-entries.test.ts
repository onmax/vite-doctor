import { expect, test } from "vite-plus/test";
import { FINGERPRINT_SCHEME } from "../../src/core/diagnostic-constants.ts";
import { createJsonReport } from "../../src/core/reports.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noClientSecretPattern, noUntypedEnv } from "../../src/rules.ts";
import { noUnpassedProps } from "../../src/rule-packs/vue/rules/vue/no-unpassed-props.ts";
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
  expect(result.diagnostics[0]!.suggestion).toContain("Delete only the fingerprints");
  expect(result.diagnostics[0]!.suggestion).not.toContain("--update-baseline");
});

test("a saved JSON report retains resolution metadata for visible and suppressed findings", async () => {
  const recorded = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": leaking, "src/other.ts": leaking },
    config: { suppressions: [{ ruleId, file: "src/other.ts", reason: "Accepted for now." }] },
  });
  expect(recorded.diagnostics).toHaveLength(1);
  expect(recorded.suppressedDiagnostics).toHaveLength(1);
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: {
      "src/main.ts": fixed,
      "src/other.ts": fixed,
      "baseline.json": createJsonReport(recorded),
    },
    run: { baseline: "baseline.json", newOnly: true },
  });
  expect(result.diagnostics).toMatchObject([
    {
      code: "DOC0039",
      evidence: [
        {
          summary: `${ruleId} no longer reports fingerprint ${recorded.diagnostics[0]!.fingerprint} in src/main.ts.`,
        },
        {
          summary: `${ruleId} no longer reports fingerprint ${recorded.suppressedDiagnostics![0]!.fingerprint} in src/other.ts.`,
        },
      ],
    },
  ]);
});

test("a preset Rule re-enabled by an override does not cover other files", async () => {
  const ruleId = noUntypedEnv.meta.id;
  const files = { "src/main.ts": leaking, "src/other.ts": leaking };
  const options = { framework: "vite" as const, rules: [noUntypedEnv] };
  const recorded = await runProjectFixture({ ...options, files });
  const findings = recorded.diagnostics.filter((diagnostic) => diagnostic.ruleId === ruleId);
  expect(findings).toHaveLength(2);
  const result = await runProjectFixture({
    ...options,
    files: {
      ...files,
      "baseline.json": baselineJson(
        findings.map(({ file, fingerprint }) => ({
          ruleId,
          file: file.endsWith("src/main.ts") ? "src/main.ts" : "src/other.ts",
          fingerprint,
        })),
      ),
    },
    config: {
      rules: { [ruleId]: "off" },
      overrides: [{ files: ["src/other.ts"], rules: { [ruleId]: "warn" } }],
    },
    run: { baseline: "baseline.json", newOnly: true },
  });
  expect(resolvedEntries(result.diagnostics)).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    {
      fingerprint: findings.find((diagnostic) => diagnostic.file.endsWith("src/other.ts"))!
        .fingerprint,
    },
  ]);
});

test("an excluded caller does not make a workspace Rule finding resolved", async () => {
  const child = "src/Child.vue";
  const caller = "src/App.vue";
  const files = {
    [child]: `<script setup lang="ts">defineProps<{ label?: string }>()</script><template><button>{{ label }}</button></template>`,
    [caller]: `<script setup>import Child from './Child.vue'</script><template><Child /></template>`,
  };
  const options = { framework: "vue" as const, rules: [noUnpassedProps] };
  const recorded = await runProjectFixture({ ...options, files });
  const finding = recorded.diagnostics.find(({ code }) => code === "VUE0039")!;
  expect(finding.file).toMatch(/src\/Child\.vue$/);
  const result = await runProjectFixture({
    ...options,
    files: {
      ...files,
      "baseline.json": baselineJson([
        { ruleId: finding.ruleId, file: child, fingerprint: finding.fingerprint },
      ]),
    },
    config: { exclude: [caller] },
    run: { baseline: "baseline.json", newOnly: true },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toEqual([]);
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
