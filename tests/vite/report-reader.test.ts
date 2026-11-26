import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { startMcpStub } from "../mcp/mcp-stub.ts";
import { stubReaderEnv } from "../report-reader-env.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/mcp/nuxt.json", import.meta.url), "utf8"),
);

let root: string;
let stub: Awaited<ReturnType<typeof startMcpStub>>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "doctor-reader-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  stub = await startMcpStub({ tools: fixture.tools });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

const args = () => [".", "--no-cache", "--extends", "auto,mcp/strict", "--mcp-url", stub.url];

test("an agent running Doctor in CI gets the agent report", async () => {
  stubReaderEnv({ CI: "1", CLAUDECODE: "1" });
  const run = await capture(() => main(args(), root));
  expect(run.code).toBe(0);
  const report = JSON.parse(run.stdout);
  expect(report.schema).toBe("vite-doctor.agent/v3");
  expect(run.stdout.length).toBeLessThanOrEqual(8000);
});

test("CI without an agent prints the complete text report", async () => {
  stubReaderEnv({ CI: "1" });
  const run = await capture(() => main(args(), root));
  expect(run.code).toBe(0);
  expect(run.stdout.length).toBeGreaterThan(8000);
  expect(run.stdout).not.toMatch(/^ {2}more: /m);
  expect(run.stdout).not.toMatch(/^(Hidden: |Detail hidden for )/m);
  expect(run.stderr).toBe("");
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
