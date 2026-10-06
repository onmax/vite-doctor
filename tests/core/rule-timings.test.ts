import { expect, test } from "vite-plus/test";
import { createJsonReport, createReport } from "../../src/core/index.ts";
import { createRule } from "../../src/core/primitives.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";

const fileRule = createRule({
  meta: { id: "test/file-rule", title: "File rule", category: "performance", severity: "info" },
  create() {
    return { Identifier() {} };
  },
});

const workspaceRule = createRule({
  meta: {
    id: "test/workspace-rule",
    title: "Workspace rule",
    category: "performance",
    severity: "info",
    execution: "workspace",
  },
  create() {
    return { onWorkspaceEnd() {} };
  },
});

const files = { "src/a.ts": "export const a = 1", "src/b.ts": "export const b = 2" };

test("profiled runs report time per rule with the files it visited", async () => {
  const result = await runProjectFixture({
    files,
    framework: "vite",
    rules: [fileRule, workspaceRule],
    run: { profile: true },
  });

  expect(result.ruleTimings?.map((timing) => timing.rule).sort()).toEqual([
    "test/file-rule",
    "test/workspace-rule",
  ]);
  expect(result.ruleTimings?.find((timing) => timing.rule === "test/file-rule")?.files).toBe(2);
  expect(result.ruleTimings?.find((timing) => timing.rule === "test/workspace-rule")?.files).toBe(
    0,
  );
  expect(JSON.parse(createJsonReport(result)).ruleTimings).toEqual(result.ruleTimings);
  expect(createReport(result, "text")).toContain("Slowest rules");
});

test("unprofiled runs omit rule timings", async () => {
  const result = await runProjectFixture({ files, framework: "vite", rules: [fileRule] });

  expect(result.ruleTimings).toBeUndefined();
  expect(JSON.parse(createJsonReport(result))).not.toHaveProperty("ruleTimings");
});
