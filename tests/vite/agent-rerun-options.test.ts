import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { createAgentReport } from "../../src/core/reports.ts";
import { runViteDoctor } from "../../src/doctor.ts";

const roots: string[] = [];
const secretRule = "vite/env/no-client-secret-pattern";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doctor-agent-replay-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/app.js"), "console.log(import.meta.env.VITE_API_SECRET);");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(root: string, args: string[]) {
  let output = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    const code = await main(args, root);
    return { code, report: JSON.parse(output) };
  } finally {
    stdout.mockRestore();
  }
}

test.each([
  ["--rules", secretRule],
  ["--severity", "error"],
  ["--analyses", "graph"],
])("agent rerun preserves %s and reproduces the selected findings", async (flag, value) => {
  const root = fixture();
  const original = await run(root, [
    ".",
    "--framework",
    "vite",
    "--extends",
    "vite/strict",
    "--format",
    "agent",
    flag,
    value,
  ]);
  const replay = await run(original.report.project.cwd, original.report.commandArgs.rerun.slice(1));
  expect(replay.code).toBe(original.code);
  expect(replay.report.diagnostics).toEqual(original.report.diagnostics);
  expect(replay.report.summary).toEqual(original.report.summary);
  expect(original.report.commandArgs.rerun).toEqual(expect.arrayContaining([flag, value]));
});

test("agent rerun retains baseline suppression and a literal baseline path", async () => {
  const root = fixture();
  const initial = await run(root, [".", "--framework", "vite", "--format", "agent"]);
  expect(initial.report.diagnostics.length).toBeGreaterThan(0);
  const baseline = "baseline $VALUE's.json";
  writeFileSync(
    join(root, baseline),
    JSON.stringify(initial.report.diagnostics.map((d: any) => d.fingerprint)),
  );
  const original = await run(root, [
    ".",
    "--framework",
    "vite",
    "--format",
    "agent",
    "--baseline",
    baseline,
    "--new-only",
  ]);
  expect(original.code).toBe(0);
  expect(original.report.diagnostics).toEqual([]);
  const replay = await run(root, original.report.commandArgs.rerun.slice(1));
  expect(replay.code).toBe(0);
  expect(replay.report.diagnostics).toEqual([]);
});

test("agent rerun and focused verification retain explicitly trusted config and failure policy", async () => {
  const root = fixture();
  const config = "policy $VALUE's.mjs";
  writeFileSync(
    join(root, config),
    `export default { rules: { ${JSON.stringify(secretRule)}: "warn" } };`,
  );
  const original = await run(root, [
    ".",
    "--framework",
    "vite",
    "--format",
    "agent",
    "--config",
    config,
    "--rules",
    secretRule,
    "--max-warnings",
    "0",
    "--no-cache",
    "--profile",
  ]);
  expect(original.code).toBe(1);
  expect(original.report.summary.warn).toBe(1);
  for (const command of ["rerun", "verify"]) {
    const args = original.report.commandArgs[command].map((arg: string) =>
      arg === "<rule>" ? secretRule : arg,
    );
    const replay = await run(root, args.slice(1));
    expect(replay.code).toBe(original.code);
    expect(replay.report.diagnostics).toEqual(original.report.diagnostics);
    expect(args).toEqual(
      expect.arrayContaining([
        "--config",
        config,
        "--max-warnings",
        "0",
        "--no-cache",
        "--profile",
      ]),
    );
  }
  expect(existsSync(join(root, ".vite-doctor/cache"))).toBe(false);
});

test("generated verification commands never discover executable configuration", async () => {
  const root = fixture();
  writeFileSync(join(root, "doctor.config.mjs"), 'throw new Error("Untrusted config executed");');
  const original = await run(root, [".", "--framework", "vite", "--format", "agent"]);
  expect(original.code).toBe(1);
  expect(original.report.commandArgs.rerun).not.toContain("--config");
  const replay = await run(root, original.report.commandArgs.rerun.slice(1));
  expect(replay.report.diagnostics).toEqual(original.report.diagnostics);
});

test("report context preserves explicit cache policy while verification omits mutations", async () => {
  const root = fixture();
  const result = await runViteDoctor({ root, framework: "vite", cache: false });
  const report = JSON.parse(
    createAgentReport(result, {
      runOptions: {
        rules: secretRule,
        cache: true,
        fix: true,
        unsafeFix: true,
        updateBaseline: true,
      },
    }),
  );
  expect(report.commandArgs.rerun).toEqual(
    expect.arrayContaining(["--cache", "--rules", secretRule]),
  );
  expect(report.commandArgs.verify).toEqual(
    expect.arrayContaining(["--cache", "--rules", "<rule>"]),
  );
  for (const command of ["rerun", "verify"]) {
    for (const flag of ["--fix", "--unsafe-fix", "--update-baseline"])
      expect(report.commandArgs[command]).not.toContain(flag);
  }
});
