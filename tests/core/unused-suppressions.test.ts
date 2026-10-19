import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { defineDoctorExtension, defineRulePack, runDoctor } from "../../src/core/index.ts";
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
    run: { severity: "warn" },
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
    const viteConfig = (reason: string) =>
      [
        "export default {",
        "  doctor: {",
        "    suppressions: [",
        `      { ruleId: ${JSON.stringify(ruleId)}, file: "src/main.ts", reason: ${JSON.stringify(reason)} },`,
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n");
    writeFileSync(join(root, "vite.config.ts"), viteConfig("Before."));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init");
    git("add", ".");
    git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.com", "commit", "-m", "init");
    writeFileSync(join(root, "vite.config.ts"), viteConfig(stale.reason));
    // The suppressed file is unchanged, so a changed-file run cannot prove the entry stale.
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      since: "HEAD",
      config: { suppressions: [stale] },
      extensions: [
        defineDoctorExtension({
          name: "fixture",
          rulePacks: [
            defineRulePack({
              name: "fixture",
              version: "0.0.0",
              rules: [noClientSecretPattern],
              presets: { recommended: [ruleId] },
            }),
          ],
        }),
      ],
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "DOC0031")).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a config suppression without a Rule does not hide the DOC0031 it causes", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(1)\n" },
    config: { suppressions: [{ reason: "Hide everything." }] },
  });
  expect(result.diagnostics).toMatchObject([{ code: "DOC0031" }]);
});

test("a config suppression without a Rule is not reported while a Rule is turned off", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(1)\n" },
    config: {
      suppressions: [{ fingerprint: "stale", reason: "Accepted." }],
      rules: { [ruleId]: "off" },
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("a config suppression for an excluded file is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(import.meta.env.VITE_SECRET)\n" },
    config: { suppressions: [stale], exclude: ["src/main.ts"] },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "DOC0031")).toEqual([]);
});

test("a glob suppression is not reported when the source inventory may be incomplete", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(1)\n" },
    config: {
      suppressions: [{ ruleId, file: "src/*.ts", reason: "Moved." }],
    },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "DOC0031")).toEqual([]);
});

test("a config suppression for a file Doctor could not parse is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(import.meta.env.VITE_SECRET\nconst = ;\n" },
    config: { suppressions: [stale] },
  });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "DOC0031")).toEqual([]);
});

test("a config suppression for a deleted file is reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/other.ts": "console.log(1)\n" },
    config: { suppressions: [stale] },
  });
  expect(result.diagnostics).toMatchObject([{ code: "DOC0031" }]);
});

test("a config suppression without a Rule is reported when extends composes auto", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(1)\n" },
    config: { extends: ["auto"], suppressions: [{ file: "src/gone.ts", reason: "Moved." }] },
  });
  expect(result.diagnostics).toMatchObject([{ code: "DOC0031" }]);
});

test("identical stale suppressions get distinct identities", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: { "src/main.ts": "console.log(1)\n" },
    config: { suppressions: [stale, { ...stale }] },
  });
  expect(result.diagnostics).toMatchObject([
    { code: "DOC0031", range: { line: 3 } },
    { code: "DOC0031", range: { line: 8 } },
  ]);
  expect(result.diagnostics[0]!.fingerprint).not.toBe(result.diagnostics[1]!.fingerprint);
});
