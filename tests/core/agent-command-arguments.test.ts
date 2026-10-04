import { spawnSync } from "node:child_process";
import { expect, test } from "vite-plus/test";
import { createAgentReport } from "../../src/core/reports.ts";
import { createResult } from "../../src/core/internal/diagnostics.ts";

function report(base: string, presets = ["vite/strict"]) {
  const project = {
    root: "/project",
    framework: "vite" as const,
    ssr: false,
    vueVersion: ">=3.5",
    isMonorepo: false,
  };
  const result = createResult(project, project.root, [], [], {});
  result.scope = { mode: "changed", files: 1, base };
  result.extends = presets;
  return JSON.parse(createAgentReport(result));
}

test.each([
  "main",
  "topic/$DOCTOR_TEST_VALUE",
  "topic/$(printf${IFS}injected)",
  "topic/a'b",
  "topic/a;b",
  "HEAD@{2026-10-01 12:00:00}",
])("agent commands preserve the literal revision %s", (base) => {
  const result = report(base);
  const args = [
    "vite-doctor",
    ".",
    "--framework",
    "vite",
    "--since",
    base,
    "--extends",
    "vite/strict",
    "--format",
    "agent",
  ];
  expect(result.commandArgs.rerun).toEqual(args);
  expect(result.commandArgs.verify).toEqual([
    ...args.slice(0, -2),
    "--rules",
    "<rule>",
    "--format",
    "agent",
  ]);
  expect(result.commandArgs.explain).toEqual([
    "vite-doctor",
    "explain",
    "<code>",
    "--framework",
    "vite",
    "--format",
    "agent",
  ]);
});

test
  .skipIf(process.platform === "win32")
  .each([
    "main",
    "topic/$DOCTOR_TEST_VALUE",
    "topic/$(printf${IFS}injected)",
    "topic/a'b",
    "topic/a;b",
    "HEAD@{2026-10-01 12:00:00}",
  ])("POSIX command templates preserve literal revision arguments: %s", (base) => {
  const result = report(base);
  const capture = spawnSync("sh", ["-c", `set -- ${result.commands.rerun}; printf '%s\\n' "$@"`], {
    encoding: "utf8",
    env: { ...process.env, DOCTOR_TEST_VALUE: "expanded" },
  });

  expect(capture.status).toBe(0);
  expect(capture.stdout.trimEnd().split("\n")).toEqual([
    "vite-doctor",
    ".",
    "--framework",
    "vite",
    "--since",
    base,
    "--extends",
    "vite/strict",
    "--format",
    "agent",
  ]);
});

test.skipIf(process.platform === "win32")(
  "POSIX templates preserve preset selectors and placeholders as literal arguments",
  () => {
    const presets = ["custom/a'b", "custom/$DOCTOR_TEST_VALUE", "custom/a;b"];
    const result = report("main", presets);
    for (const name of ["explain", "verify", "rerun"]) {
      const capture = spawnSync(
        "sh",
        ["-c", `set -- ${result.commands[name]}; printf '%s\\n' "$@"`],
        {
          encoding: "utf8",
          env: { ...process.env, DOCTOR_TEST_VALUE: "expanded" },
        },
      );
      expect(capture.status).toBe(0);
      expect(capture.stdout.trimEnd().split("\n")).toEqual(result.commandArgs[name]);
    }
    expect(result.commandArgs.rerun).toContain(presets.join(","));
  },
);
