import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import type { DoctorRuleConfig } from "../../src/core/config.ts";
import { noClientSecretPattern } from "../../src/rule-packs/vite/rules/env.ts";
import { createAgentReport } from "../../src/core/reports.ts";

const unused = "workspace/dead-code/unused-file";
const unresolved = "workspace/dead-code/unresolved-import";
const files = {
  "src/main.ts": 'import "./missing.ts";',
  "src/unused.ts": 'console.log("unused");',
};

test.each([
  { rules: unused, expected: [unused] },
  { rules: "workspace/dead-code/unused-*", expected: [unused] },
  { rules: ` ${unused}, ${unresolved} `, expected: [unresolved, unused] },
  { rules: "vite/env/*", expected: [] },
  { rules: " , ", expected: [unresolved, unused] },
])("workspace findings respect Rule selection $rules", async ({ rules, expected }) => {
  const result = await runProjectFixture({
    rules: [noClientSecretPattern],
    framework: "vite",
    files,
    run: { analyses: "dead-code", rules },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId).sort()).toEqual(expected.sort());
});

test("workspace diagnostics honor configured disabling even when explicitly selected", async () => {
  const result = await runProjectFixture({
    rules: [noClientSecretPattern],
    framework: "vite",
    files,
    config: { rules: { [unresolved]: "off" } },
    run: { analyses: "dead-code", rules: unresolved },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each<{ name: string; configuration: DoctorRuleConfig }>([
  { name: "scalar", configuration: "error" },
  { name: "tuple", configuration: ["error", {}] },
])(
  "workspace severity configuration $name controls severity filtering and failure counts",
  async ({ configuration }) => {
    const result = await runProjectFixture({
      rules: [noClientSecretPattern],
      framework: "vite",
      files,
      config: { rules: { [unused]: configuration } },
      run: { analyses: "dead-code", rules: unused, severity: "error" },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ ruleId: unused, severity: "error" }),
    ]);
    expect(result.summary.error).toBe(1);
    expect(JSON.parse(createAgentReport(result))).toMatchObject({ status: "findings" });
  },
);

test.each<{ analysis: string; rule: string; files: Record<string, string> }>([
  {
    analysis: "graph",
    rule: "workspace/dead-code/circular-dependency",
    files: { "src/index.ts": 'import "./cycle.ts";', "src/cycle.ts": 'import "./index.ts";' },
  },
  {
    analysis: "health",
    rule: "workspace/health/high-cyclomatic-complexity",
    files: { "src/main.ts": `export function run(n) { ${"if(n) console.log(n);".repeat(20)} }` },
  },
  {
    analysis: "dupes",
    rule: "workspace/duplication/exact-clone",
    files: {
      "src/first.ts": `export function run(n) { ${"if(n) console.log(n);".repeat(20)} }`,
      "src/second.ts": `export function run(n) { ${"if(n) console.log(n);".repeat(20)} }`,
    },
  },
])("$analysis diagnostics honor configured disabling", async ({ analysis, rule, files }) => {
  const baseline = await runProjectFixture({
    rules: [noClientSecretPattern],
    framework: "vite",
    files,
    run: { analyses: analysis },
  });
  expect(baseline.diagnostics.some((diagnostic) => diagnostic.ruleId === rule)).toBe(true);
  const result = await runProjectFixture({
    rules: [noClientSecretPattern],
    framework: "vite",
    files,
    config: { rules: { [rule]: "off" } },
    run: { analyses: analysis },
  });
  expect(result.diagnostics.some((diagnostic) => diagnostic.ruleId === rule)).toBe(false);
});

test("Rule selection preserves unresolved Runtime Evidence diagnostics", async () => {
  const result = await runProjectFixture({
    rules: [noClientSecretPattern],
    framework: "nuxt",
    files: { "app/app.vue": "<template><p>App</p></template>" },
    run: { analyses: "dead-code", rules: unused, runtimeTarget: {} },
  });
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "DOC0022")).toBe(true);
  expect(JSON.parse(createAgentReport(result))).toMatchObject({ status: "incomplete" });
});
