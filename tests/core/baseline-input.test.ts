import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { applyDiagnosticPolicy } from "../../src/core/internal/diagnostic-policy.ts";
import { normalizeDiagnosticFromRuleCode } from "../../src/core/internal/diagnostics.ts";
import { main } from "../../src/cli.ts";

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
  ["unsupported version", '{"version":2,"diagnostics":[]}'],
  ["string version", '{"version":"1","diagnostics":[]}'],
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

test("a missing baseline can still be initialized and used on the next run", () => {
  const { baseline, diagnostic, input } = fixture();
  expect(applyDiagnosticPolicy(input).diagnostics).toEqual([diagnostic]);
  applyDiagnosticPolicy({ ...input, options: { ...input.options, updateBaseline: true } });
  expect(JSON.parse(readFileSync(baseline, "utf8"))).toMatchObject({ version: 1 });
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
