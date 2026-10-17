import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runDoctor } from "../../src/core/index.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noClientSecretPattern } from "../../src/rules.ts";

const ruleId = noClientSecretPattern.meta.id;
const stale = { ruleId, file: "src/main.ts", reason: "The secret was moved server-side." };

test("a config suppression that matches no Diagnostic reports DOC0031 at the entry", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(import.meta.env.VITE_PUBLIC_URL)\n" },
    config: { suppressions: [stale] },
  });
  expect(result.diagnostics).toMatchObject([
    {
      code: "DOC0031",
      ruleId: "doctor/config/unused-suppression",
      severity: "info",
      file: expect.stringMatching(/doctor\.config\.ts$/),
      range: { line: 3 },
    },
  ]);
  expect(result.diagnostics[0]!.why).toContain(ruleId);
  expect(result.diagnostics[0]!.why).toContain("src/main.ts");
});

test("a config suppression that matches a Diagnostic is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(import.meta.env.VITE_SECRET)\n" },
    config: { suppressions: [stale] },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ ruleId }]);
});

test("a config suppression matched below the severity threshold is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(import.meta.env.VITE_SECRET)\n" },
    config: { suppressions: [stale], rules: { [ruleId]: "info" } },
    run: { severity: "info" },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["a Rule outside the selection", { rules: "vite/env/no-untyped-env" }],
  ["a Rule-scoped selection", { rules: ruleId }],
  ["analyses-only runs", { analyses: "dead-code" }],
])("a config suppression is not reported for %s", async (_, run) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(1)\n" },
    config: { suppressions: [stale] },
    run,
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "DOC0031")).toEqual([]);
});

test("a config suppression for a disabled Rule is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(1)\n" },
    config: { suppressions: [stale], rules: { [ruleId]: "off" } },
  });
  expect(result.diagnostics).toEqual([]);
});

test("a config suppression is not reported for changed-file runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-unused-suppression-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vite: "^7.0.0" } }),
    );
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.ts"), "console.log(import.meta.env.VITE_SECRET)\n");
    writeFileSync(join(root, "src/other.ts"), "console.log(1)\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init");
    git("add", ".");
    git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.com", "commit", "-m", "init");
    writeFileSync(join(root, "src/other.ts"), "console.log(2)\n");
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      since: "HEAD",
      config: { suppressions: [stale] },
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "DOC0031")).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
