import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createAgentReport,
  createSarifReport,
  createTextReport,
  type DiagnosticOrigin,
} from "../../src/core/index.ts";
import { createResult, normalizeDiagnostic } from "../../src/core/internal/diagnostics.ts";

const root = resolve("/doctor-origin-reports");
const live = [{ source: "mcp", target: "https://mcp.example.com" }];

function finding(file: string, origin?: DiagnosticOrigin, subject?: string) {
  return normalizeDiagnostic({
    diagnostic: allDiagnostics.DOC9999({ why: `Problem in ${file}.`, fix: "Fix it." }),
    ruleId: "test/origin",
    severity: "warn",
    category: "test",
    file: resolve(root, file),
    range: file ? { start: 0, end: 1, line: 1, column: 1 } : undefined,
    origin,
    subject,
  });
}

function resultFor(...diagnostics: ReturnType<typeof finding>[]) {
  return createResult(
    { root, framework: "vite", ssr: false, vueVersion: "3.5.0", isMonorepo: false },
    root,
    diagnostics,
    [],
    {},
  );
}

test("text rows of a code-only run carry no origin tag", () => {
  const result = resultFor(finding("src/a.ts"), finding("src/b.ts"), finding("src/c.ts"));
  const report = createTextReport(result, { runOptions: { maxChars: 730 } });
  expect(report).toMatch(/^ {2}src\/a\.ts:1:1 {2}Problem/m);
  expect(report).not.toContain("code+live");
});

test("text rows tag each origin once origins mix, and passing source prompts a deployment check", () => {
  const result = resultFor(
    finding("src/a.ts"),
    finding("src/b.ts", { code: "found", live }),
    finding("src/c.ts", { code: "passes", live }),
  );
  const rows = createTextReport(result, { runOptions: { maxChars: 800 } });
  expect(rows).toMatch(/^ {2}code {7}src\/a\.ts:1:1 {2}Problem in src\/a\.ts\.$/m);
  expect(rows).toMatch(/^ {2}code\+live {2}src\/b\.ts:1:1 {2}Problem in src\/b\.ts\.$/m);
  expect(rows).toMatch(
    /^ {2}live {7}src\/c\.ts:1:1 {2}Problem in src\/c\.ts\. · check deployment$/m,
  );

  const detail = createTextReport(result);
  expect(detail).toContain(
    "    origin: live at https://mcp.example.com; the source passes the static check; check the deployment and runtime configuration",
  );
  expect(detail).toContain("    origin: live at https://mcp.example.com; the source has it too");
});

test.each([
  ["found", "code+live"],
  ["not-checked", "live"],
] as const)("text rows show provenance even if every finding is %s", (code, tag) => {
  const result = resultFor(
    ...["a", "b", "c", "d", "e"].map((name) => finding(`src/${name}.ts`, { code, live })),
  );
  const rows = createTextReport(result, { runOptions: { maxChars: 1000 } });
  expect(rows).toContain(`  ${tag.padEnd(9)}  src/a.ts:1:1  Problem`);
});

test("text details say when Doctor did not verify the source", () => {
  const detail = createTextReport(resultFor(finding("src/a.ts", { code: "not-checked", live })));
  expect(detail).toContain(
    "    origin: live at https://mcp.example.com; the source was not verified",
  );
});

test("text details distinguish an unmatched definition from absent source", () => {
  const detail = createTextReport(resultFor(finding("", { code: "no-definition", live })));
  expect(detail).toContain(
    "    origin: live at https://mcp.example.com; no unique source definition matched",
  );
});

test("the agent report carries origin and reserves deployment guidance for passing source", () => {
  const report = JSON.parse(
    createAgentReport(resultFor(finding("src/c.ts", { code: "passes", live }))),
  );
  expect(report.groups[0].diagnostics[0].origin).toEqual({ code: "passes", live });
  expect(report.next.instruction).toContain("Verify live findings against the same target.");
  expect(report.next.instruction).toContain('When origin.code is "passes",');
  expect(report.next.instruction).toContain(
    "check the deployed version and runtime configuration before editing source or redeploying",
  );

  const unchecked = JSON.parse(
    createAgentReport(resultFor(finding("src/a.ts", { code: "not-checked", live }))),
  );
  expect(unchecked.next.instruction).toContain("Verify live findings against the same target.");
  expect(unchecked.next.instruction).not.toMatch(/deploy/i);

  const code = JSON.parse(createAgentReport(resultFor(finding("src/a.ts"))));
  expect(code.groups[0].diagnostics[0].origin).toBeUndefined();
  expect(code.next.instruction).not.toMatch(/live|deploy/i);
});

test("the agent report retains live verification guidance when evidence is incomplete", () => {
  const result = resultFor(finding("src/a.ts", { code: "passes", live }));
  result.project.evidenceGaps = [
    { source: "test", message: "Restore the missing evidence.", files: [] },
  ];
  const report = JSON.parse(createAgentReport(result));
  expect(report.next.action).toBe("restore-evidence");
  expect(report.next.instruction).toMatch(/^Restore the missing evidence\./);
  expect(report.next.instruction).toContain("Verify live findings against the same target.");
  expect(report.next.instruction).toContain("check the deployed version and runtime configuration");
});

test("SARIF names the live subject as a logical location next to where to fix it", () => {
  const report = JSON.parse(
    createSarifReport(
      resultFor(
        finding("", { code: "no-definition", live }, "search"),
        finding("src/a.ts", { code: "found", live }, "list_drops"),
        finding("src/b.ts"),
      ),
    ),
  );
  const [remote, defined, code] = report.runs[0].results;
  expect(remote.properties.origin).toEqual({ code: "no-definition", live });
  expect(remote.locations[0].logicalLocations).toEqual([{ name: "search", kind: "resource" }]);
  expect(defined.locations[0].logicalLocations).toEqual([{ name: "list_drops", kind: "resource" }]);
  expect(defined.locations[0].physicalLocation.artifactLocation.uri).toBe("src/a.ts");
  expect(code.properties.origin).toBeUndefined();
  expect(code.locations[0].logicalLocations).toBeUndefined();
});
