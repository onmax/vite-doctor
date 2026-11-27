import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createAgentReport,
  createSarifReport,
  createTextReport,
  type DiagnosticOrigin,
} from "../../src/core/index.ts";
import { createResult, normalizeDiagnostic } from "../../src/core/internal/diagnostics.ts";

const root = resolve(tmpdir(), "doctor-origin-reports");
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
  const report = createTextReport(result, { runOptions: { maxChars: 680 } });
  expect(report).toMatch(/^ {2}src\/a\.ts:1:1 {2}Problem/m);
  expect(report).not.toContain("code+live");
});

test("text rows tag each origin once origins mix, and a stale deployment says redeploy", () => {
  const result = resultFor(
    finding("src/a.ts"),
    finding("src/b.ts", { code: "found", live }),
    finding("src/c.ts", { code: "passes", live }),
  );
  const rows = createTextReport(result, { runOptions: { maxChars: 760 } });
  expect(rows).toMatch(/^ {2}code {7}src\/a\.ts:1:1 {2}Problem in src\/a\.ts\.$/m);
  expect(rows).toMatch(/^ {2}code\+live {2}src\/b\.ts:1:1 {2}Problem in src\/b\.ts\.$/m);
  expect(rows).toMatch(/^ {2}live {7}src\/c\.ts:1:1 {2}Problem in src\/c\.ts\. · redeploy$/m);

  const detail = createTextReport(result);
  expect(detail).toContain(
    "    origin: live at https://mcp.example.com; the source already passes, so redeploy instead of editing",
  );
  expect(detail).toContain("    origin: live at https://mcp.example.com; the source has it too");
});

test("the agent report carries origin and tells the agent a live finding clears after a deploy", () => {
  const report = JSON.parse(
    createAgentReport(resultFor(finding("src/c.ts", { code: "passes", live }))),
  );
  expect(report.groups[0].diagnostics[0].origin).toEqual({ code: "passes", live });
  expect(report.next.instruction).toContain("clears only after the fix is deployed");

  const code = JSON.parse(createAgentReport(resultFor(finding("src/a.ts"))));
  expect(code.groups[0].diagnostics[0].origin).toBeUndefined();
  expect(code.next.instruction).not.toContain("deployed");
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
