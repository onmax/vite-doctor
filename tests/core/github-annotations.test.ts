import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vite-plus/test";
import { allDiagnostics, type Diagnostic, type DoctorSeverity } from "../../src/core/index.ts";
import { createResult, normalizeDiagnostic } from "../../src/core/internal/diagnostics.ts";
import { githubAnnotations } from "../../src/core/internal/github-annotations.ts";
import { stubReaderEnv } from "../report-reader-env.ts";

const workspace = mkdtempSync(join(tmpdir(), "doctor-annotations-"));
const root = join(workspace, "app");
mkdirSync(join(root, "src"), { recursive: true });

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function finding(severity: DoctorSeverity, extra: Partial<Diagnostic> = {}): Diagnostic {
  return {
    ...normalizeDiagnostic({
      diagnostic: allDiagnostics.DOC9999({ why: "Something is off.", fix: "Fix it." }),
      ruleId: "test/annotations",
      severity,
      category: "test",
      file: join(root, "src/app.ts"),
    }),
    ...extra,
  };
}

function annotate(diagnostics: Diagnostic[], format: "text" | "json" | "agent" = "text") {
  const result = createResult(
    { root, framework: "vite", ssr: false, vueVersion: "3.5.0", isMonorepo: false },
    root,
    diagnostics,
    [],
    {},
  );
  return githubAnnotations(result, format, "ci", root);
}

function inGitHubActions() {
  stubReaderEnv({ CI: "true", GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: workspace });
}

test("errors and warnings become workflow commands relative to GITHUB_WORKSPACE", () => {
  inGitHubActions();
  const file = join(root, "src/range.ts");
  writeFileSync(file, "const a = 1;\nconst secret = process.env.KEY;\n");
  const start = "const a = 1;\nconst ".length;
  const output = annotate([
    finding("blocker", { file, range: { start, end: start + 6, line: 2, column: 7 } }),
    finding("error", { brief: "A short brief." }),
    finding("warn"),
  ]);
  expect(output.split("\n")).toEqual([
    "::error title=DOC9999,file=app/src/range.ts,line=2,col=7,endLine=2,endColumn=13::Something is off.%0Ahttps://vite-doctor.onmax.me/diagnostics/DOC9999",
    "::error title=DOC9999,file=app/src/app.ts::A short brief.%0Ahttps://vite-doctor.onmax.me/diagnostics/DOC9999",
    "::warning title=DOC9999,file=app/src/app.ts::Something is off.%0Ahttps://vite-doctor.onmax.me/diagnostics/DOC9999",
    "",
  ]);
});

test("falls back to the CLI's cwd without GITHUB_WORKSPACE", () => {
  stubReaderEnv({ CI: "true", GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: undefined });
  expect(annotate([finding("warn")])).toMatch(/^::warning title=DOC9999,file=src\/app\.ts::/);
});

test.each([
  { name: "multiline", source: "first\nsecond\nthird", end: 8, location: "line=1,endLine=2" },
  { name: "final CRLF", source: "first\r\nsecond\r\n", end: 15, location: "line=1,endLine=2" },
  {
    name: "single line including its newline",
    source: "first\nsecond",
    end: 6,
    location: "line=1,col=2,endLine=1,endColumn=6",
  },
])("annotates only the lines covered by the range ($name)", ({ source, end, location }) => {
  inGitHubActions();
  const file = join(root, "src/range-end.ts");
  writeFileSync(file, source);
  const output = annotate([
    finding("warn", { file, range: { start: 1, end, line: 1, column: 2 } }),
  ]);
  expect(output).toContain(`,file=app/src/range-end.ts,${location}::`);
});

test("escapes data and property values", () => {
  inGitHubActions();
  const output = annotate([
    finding("warn", { file: join(root, "src/a,b:c%.ts"), brief: "100% sure\r\nnext: line, end" }),
  ]);
  expect(output).toContain("file=app/src/a%2Cb%3Ac%25.ts::100%25 sure%0D%0Anext: line, end%0A");
});

test("caps each kind at 10 in report order and skips info", () => {
  inGitHubActions();
  const diagnostics = [
    ...Array.from({ length: 12 }, (_, line) =>
      finding("warn", { range: { start: 0, end: 0, line: line + 1, column: 1 } }),
    ),
    finding("info"),
    ...Array.from({ length: 12 }, (_, line) =>
      finding("error", { range: { start: 0, end: 0, line: line + 1, column: 1 } }),
    ),
  ];
  const lines = annotate(diagnostics).trimEnd().split("\n");
  expect(lines.filter((line) => line.startsWith("::error "))).toHaveLength(10);
  expect(lines.filter((line) => line.startsWith("::warning "))).toHaveLength(10);
  expect(lines).toHaveLength(20);
  expect(lines[0]).toContain("line=1,");
  expect(lines[9]).toContain("line=10,");
  expect(lines[10]).toMatch(/^::warning .*line=1,/);
});

test("project-level Diagnostics do not consume slots for source files", () => {
  inGitHubActions();
  const diagnostics = [
    finding("warn", { file: root, subject: "MCP tool search" }),
    ...Array.from({ length: 10 }, () => finding("warn", { file: root })),
    finding("warn"),
  ];
  expect(annotate(diagnostics).trimEnd().split("\n")).toEqual([
    expect.stringMatching(/^::warning title=DOC9999,file=app\/src\/app\.ts::/),
  ]);
});

test("prints nothing outside GitHub Actions, for other formats, or for other readers", () => {
  stubReaderEnv({ CI: "true", GITHUB_ACTIONS: undefined });
  expect(annotate([finding("error")])).toBe("");
  inGitHubActions();
  expect(annotate([finding("error")], "json")).toBe("");
  expect(annotate([finding("error")], "agent")).toBe("");
  const result = createResult(
    { root, framework: "vite", ssr: false, vueVersion: "3.5.0", isMonorepo: false },
    root,
    [finding("error")],
    [],
    {},
  );
  expect(githubAnnotations(result, "text", "agent", root)).toBe("");
  expect(githubAnnotations(result, "text", "terminal", root)).toBe("");
});
