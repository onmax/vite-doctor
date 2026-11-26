import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { mockReportReaderMcp, reportReaderMcpUrl, stubReaderEnv } from "../report-reader-env.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-reader-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", type: "module" }));
});

beforeEach(() => {
  mockReportReaderMcp();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const args = [".", "--no-cache", "--extends", "auto,mcp/strict", "--mcp-url", reportReaderMcpUrl];

test.each([
  ["CLAUDECODE", "1"],
  ["CURSOR_AGENT", "1"],
  ["CURSOR_EXTENSION_HOST_ROLE", "agent-exec"],
])("a strong %s marker beats an inherited weak marker in CI", async (marker, value) => {
  stubReaderEnv({ CI: "1", CURSOR_TRACE_ID: "1", [marker]: value });
  const run = await capture(() => main(args, root));
  expect(run.code).toBe(0);
  const report = JSON.parse(run.stdout);
  expect(report.schema).toBe("vite-doctor.agent/v3");
  expect(run.stdout.length).toBeLessThanOrEqual(8000);
});

test("CI with only a weak agent marker prints the complete text report", async () => {
  stubReaderEnv({ CI: "1", CURSOR_TRACE_ID: "1" });
  const run = await capture(() => main(args, root));
  expect(run.code).toBe(0);
  expect(run.stdout.length).toBeGreaterThan(8000);
  expect(run.stdout).not.toMatch(/^ {2}more: /m);
  expect(run.stdout).not.toMatch(/^(Hidden: |Detail hidden for )/m);
  expect(run.stderr).toBe("");
});

test.each([
  { args: ["missing"], notice: true },
  { args: [".", "--max-chars", "invalid"], notice: true },
  { args: ["missing", "--format", "agent"], notice: false },
])("a failing run with $args reports the automatic format only when implicit", async (input) => {
  stubReaderEnv({ CLAUDECODE: "1" });
  const tty = process.stderr.isTTY;
  process.stderr.isTTY = true;
  try {
    const run = await capture(() => main(input.args, root));
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).schema).toBe("vite-doctor.agent/v3");
    expect(run.stderr).toBe(
      input.notice
        ? "vite-doctor: agent report for claude_code; --format text prints the text report\n"
        : "",
    );
  } finally {
    process.stderr.isTTY = tty;
  }
});

async function capture(fn: () => Promise<number>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => (stdout.push(String(chunk)), true));
  const err = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => (stderr.push(String(chunk)), true));
  try {
    return { code: await fn(), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}
