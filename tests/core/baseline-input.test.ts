import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { applyDiagnosticPolicy } from "../../src/core/internal/diagnostic-policy.ts";
import { FINGERPRINT_SCHEME } from "../../src/core/diagnostic-constants.ts";
import {
  createResult,
  normalizeDiagnosticFromRuleCode,
} from "../../src/core/internal/diagnostics.ts";
import { createJsonReport } from "../../src/core/reports.ts";
import { main } from "../../src/cli.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noClientSecretPattern } from "../../src/rules.ts";
import { viteDoctorVersion } from "../../src/version.ts";
import type { DoctorConfig, DoctorRunOptions } from "../../src/core/config.ts";

const roots: string[] = [];

function fixture(contents?: string) {
  const root = mkdtempSync(join(tmpdir(), "doctor-baseline-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const baseline = join(root, "baseline.json");
  if (contents !== undefined) writeFileSync(baseline, contents);
  const diagnostic = normalizeDiagnosticFromRuleCode({
    code: "DOC9999",
    ruleId: "test/baseline",
    severity: "warn",
    category: "correctness",
    why: "A known finding.",
    suggestion: "Correct the fixture.",
    file: join(root, "app.ts"),
  });
  diagnostic.fingerprint = "known-fingerprint";
  return {
    root,
    baseline,
    diagnostic,
    input: { root, config: {}, options: { baseline, newOnly: true }, diagnostics: [diagnostic] },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  ["truncated JSON", '{"diagnostics":['],
  ["null document", "null"],
  ["scalar document", "42"],
  ["missing diagnostics", "{}"],
  ["non-array diagnostics", '{"diagnostics":{}}'],
  ["unsupported version", '{"version":3,"diagnostics":[]}'],
  ["version 2 without a fingerprint scheme", '{"version":2,"diagnostics":[]}'],
  ["non-numeric fingerprint scheme", '{"version":2,"fingerprintScheme":"2","diagnostics":[]}'],
  ["string version", '{"version":"1","diagnostics":[]}'],
  ["unsupported report version", '{"version":"0.0.12","reportVersion":4,"diagnostics":[]}'],
  ["string report version", '{"version":"0.0.12","reportVersion":"3","diagnostics":[]}'],
  ["malformed report entry", '{"version":"0.0.12","reportVersion":3,"diagnostics":[null]}'],
  ["null entry", "[null]"],
  ["numeric entry", "[42]"],
  ["boolean entry", "[true]"],
  ["array entry", "[[]]"],
  ["empty fingerprint", '[""]'],
  ["missing fingerprint", '[{"ruleId":"test/baseline"}]'],
  ["non-string fingerprint", '[{"fingerprint":42}]'],
])("rejects an existing baseline with %s without overwriting it", (_name, contents) => {
  const { baseline, input } = fixture(contents);
  expect(() => applyDiagnosticPolicy(input)).toThrow(expect.objectContaining({ code: "DOC0025" }));
  expect(() =>
    applyDiagnosticPolicy({ ...input, options: { ...input.options, updateBaseline: true } }),
  ).toThrow(expect.objectContaining({ code: "DOC0025" }));
  expect(readFileSync(baseline, "utf8")).toBe(contents);
});

test("a malformed entry cannot silently discard valid fingerprints", () => {
  const { baseline, diagnostic, input } = fixture();
  writeFileSync(baseline, JSON.stringify([diagnostic.fingerprint, null]));
  expect(() => applyDiagnosticPolicy(input)).toThrow(expect.objectContaining({ code: "DOC0025" }));
});

test.each(["strings", "objects", "unversioned", "versioned"])(
  "accepts the existing %s baseline format",
  (format) => {
    const { baseline, diagnostic, input } = fixture();
    const entries = [
      { fingerprint: diagnostic.fingerprint, ruleId: diagnostic.ruleId, file: "app.ts" },
    ];
    const value =
      format === "strings"
        ? [diagnostic.fingerprint]
        : format === "objects"
          ? entries
          : format === "unversioned"
            ? { diagnostics: entries }
            : { version: 1, diagnostics: entries };
    writeFileSync(baseline, JSON.stringify(value));
    const result = applyDiagnosticPolicy(input);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressedDiagnostics).toMatchObject([
      { fingerprint: diagnostic.fingerprint, suppressionReason: "baseline" },
    ]);
  },
);

test("Doctor JSON reports remain usable as baselines and can be updated", () => {
  const { root, baseline, diagnostic, input } = fixture();
  const project = {
    root,
    framework: "vite" as const,
    ssr: false,
    isMonorepo: false,
    vueVersion: ">=3.5",
  };
  const report = createJsonReport(createResult(project, root, [diagnostic], [], {}));
  writeFileSync(baseline, report);
  const result = applyDiagnosticPolicy(input);
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { fingerprint: diagnostic.fingerprint, suppressionReason: "baseline" },
  ]);
  expect(readFileSync(baseline, "utf8")).toBe(report);
  applyDiagnosticPolicy({ ...input, options: { ...input.options, updateBaseline: true } });
  expect(JSON.parse(readFileSync(baseline, "utf8"))).toMatchObject({
    version: 2,
    fingerprintScheme: FINGERPRINT_SCHEME,
  });
  expect(applyDiagnosticPolicy(input).diagnostics).toEqual([]);
});

test("Doctor JSON reports retain suppressed findings as baselines", () => {
  const { root, baseline, diagnostic, input } = fixture();
  const project = {
    root,
    framework: "vite" as const,
    ssr: false,
    isMonorepo: false,
    vueVersion: ">=3.5",
  };
  const report = createJsonReport(createResult(project, root, [], [diagnostic], {}));
  writeFileSync(baseline, report);

  const result = applyDiagnosticPolicy(input);

  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { fingerprint: diagnostic.fingerprint, suppressionReason: "baseline" },
  ]);
});

test("a missing baseline can still be initialized and used on the next run", () => {
  const { baseline, diagnostic, input } = fixture();
  expect(applyDiagnosticPolicy(input).diagnostics).toEqual([diagnostic]);
  applyDiagnosticPolicy({ ...input, options: { ...input.options, updateBaseline: true } });
  expect(JSON.parse(readFileSync(baseline, "utf8"))).toMatchObject({
    version: 2,
    fingerprintScheme: FINGERPRINT_SCHEME,
  });
  expect(applyDiagnosticPolicy(input).diagnostics).toEqual([]);
});

test.each(["[]", '{"version":1,"diagnostics":[]}'])(
  "an empty valid baseline keeps current findings: %s",
  (contents) => {
    const { input, diagnostic } = fixture(contents);
    expect(applyDiagnosticPolicy(input).diagnostics).toEqual([diagnostic]);
  },
);

test("an unreadable baseline path reports its location", () => {
  const { baseline, input } = fixture();
  mkdirSync(baseline);
  expect(() => applyDiagnosticPolicy(input)).toThrow(expect.objectContaining({ code: "DOC0025" }));
  expect(() => applyDiagnosticPolicy(input)).toThrow(baseline);
});

test.each(["json", "agent", "sarif"])(
  "the %s CLI stops with an invocation failure for invalid baseline JSON",
  async (format) => {
    const { root, baseline } = fixture("{");
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const code = await main([
      root,
      "--framework",
      "vite",
      "--baseline",
      baseline,
      "--new-only",
      "--no-cache",
      "--format",
      format,
    ]);
    expect(code).toBe(2);
    const report = JSON.parse(output);
    if (format === "sarif") {
      expect(report.runs[0].invocations[0].executionSuccessful).toBe(false);
    } else {
      expect(report).toMatchObject({ status: "failed", error: { kind: "invocation" } });
    }
    expect(output).toContain("Invalid Doctor baseline");
    expect(output).toContain(baseline);
  },
);

test.each([
  [
    "a version 1 baseline",
    (fingerprint: string) => ({ version: 1, diagnostics: [{ fingerprint }] }),
  ],
  ["an unversioned baseline", (fingerprint: string) => ({ diagnostics: [{ fingerprint }] })],
  ["a fingerprint array", (fingerprint: string) => [fingerprint]],
  [
    "an older fingerprint scheme",
    (fingerprint: string) => ({
      version: 2,
      fingerprintScheme: FINGERPRINT_SCHEME - 1,
      doctorVersion: "0.0.12",
      diagnostics: [{ fingerprint }],
    }),
  ],
  [
    "a JSON report without a fingerprint scheme",
    (fingerprint: string) => ({
      version: "0.0.12",
      reportVersion: 3,
      diagnostics: [{ fingerprint }],
    }),
  ],
])("%s still applies but is reported as stale", (_name, contents) => {
  const { baseline, diagnostic, input } = fixture();
  writeFileSync(baseline, JSON.stringify(contents(diagnostic.fingerprint!)));
  const result = applyDiagnosticPolicy(input);
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toHaveLength(1);
  expect(result.staleBaseline).toMatchObject({ file: baseline });
});

test("baselines record the fingerprint scheme and Doctor version that wrote them", () => {
  const { baseline, input } = fixture();
  applyDiagnosticPolicy({ ...input, options: { ...input.options, updateBaseline: true } });
  expect(JSON.parse(readFileSync(baseline, "utf8"))).toMatchObject({
    version: 2,
    fingerprintScheme: FINGERPRINT_SCHEME,
    doctorVersion: viteDoctorVersion,
  });
  expect(applyDiagnosticPolicy(input).staleBaseline).toBeUndefined();
});

test("a current JSON report is not reported as a stale baseline", () => {
  const { root, baseline, diagnostic, input } = fixture();
  const project = {
    root,
    framework: "vite" as const,
    ssr: false,
    isMonorepo: false,
    vueVersion: ">=3.5",
  };
  writeFileSync(baseline, createJsonReport(createResult(project, root, [diagnostic], [], {})));
  expect(applyDiagnosticPolicy(input).staleBaseline).toBeUndefined();
});

test("updating a stale baseline does not report it as stale", () => {
  const { baseline, diagnostic, input } = fixture();
  writeFileSync(baseline, JSON.stringify({ version: 1, diagnostics: [diagnostic] }));
  const result = applyDiagnosticPolicy({
    ...input,
    options: { ...input.options, updateBaseline: true },
  });
  expect(result.staleBaseline).toBeUndefined();
});

async function runWithStaleBaseline(
  options: {
    baseline?: string;
    config?: DoctorConfig;
    severity?: DoctorRunOptions["severity"];
  } = {},
) {
  const baseline = options.baseline ?? "baseline.json";
  const files = { "src/main.ts": "console.log(import.meta.env.VITE_SECRET)\n" };
  const initial = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files,
  });
  const [finding] = initial.diagnostics;
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: {
      ...files,
      [baseline]: JSON.stringify({
        version: 1,
        diagnostics: [{ fingerprint: finding!.fingerprint }],
      }),
    },
    config: options.config,
    run: { baseline, newOnly: true, severity: options.severity },
  });
  return { finding, result };
}

test("a Doctor Run reports a stale baseline as DOC0032", async () => {
  const { finding, result } = await runWithStaleBaseline();
  expect(result.suppressedDiagnostics).toMatchObject([{ fingerprint: finding!.fingerprint }]);
  expect(result.diagnostics).toMatchObject([
    {
      code: "DOC0032",
      ruleId: "doctor/baseline/stale-fingerprint-scheme",
      severity: "warn",
      file: expect.stringMatching(/baseline\.json$/),
    },
  ]);
  expect(result.diagnostics[0]!.suggestion).toContain("--update-baseline");
});

test("a config suppression hides DOC0032", async () => {
  const { result } = await runWithStaleBaseline({
    config: {
      suppressions: [
        { ruleId: "doctor/baseline/stale-fingerprint-scheme", reason: "Migrating next sprint." },
      ],
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toContainEqual(
    expect.objectContaining({ code: "DOC0032", suppressionReason: "Migrating next sprint." }),
  );
});

test("an error severity threshold hides DOC0032", async () => {
  const { result } = await runWithStaleBaseline({ severity: "error" });
  expect(result.diagnostics).toEqual([]);
});

test("the DOC0032 command quotes baseline paths for the shell", async () => {
  const { result } = await runWithStaleBaseline({ baseline: "base line $HOME's.json" });
  expect(result.diagnostics[0]!.suggestion).toContain(
    `--baseline 'base line $HOME'\\''s.json' --update-baseline`,
  );
});
