import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import ts from "typescript";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";

async function diagnose(first: string, second: string, analyses = "graph") {
  const root = mkdtempSync(join(tmpdir(), "doctor-type-cycles-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.ts"), first);
    writeFileSync(join(root, "src/other.ts"), second);
    return await runViteDoctor({ root, framework: "vite", analyses, cache: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  "import type { Other } from './other.ts'; export type Main = { other?: Other };",
  "export type { Other } from './other.ts'; export type Main = string;",
  "export type * from './other.ts'; export type Main = string;",
  "export type * as OtherTypes from './other.ts'; export type Main = string;",
])("erased type dependencies do not create execution cycles: %s", async (first) => {
  const emitted = ts.transpileModule(first, {
    compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
  }).outputText;
  expect(emitted).not.toContain("./other.ts");
  const result = await diagnose(
    first,
    "import './main.ts'; export interface Other { name: string }",
  );
  expect(
    result.diagnostics.filter((d) => d.ruleId === "workspace/dead-code/circular-dependency"),
  ).toEqual([]);
  expect(result.graph?.cycles).toBe(0);
});

test("mutually recursive imported types are not an execution cycle", async () => {
  const result = await diagnose(
    "import type { Other } from './other.ts'; export interface Main { other?: Other }",
    "import type { Main } from './main.ts'; export interface Other { main?: Main }",
  );
  expect(
    result.diagnostics.filter((d) => d.ruleId === "workspace/dead-code/circular-dependency"),
  ).toEqual([]);
});

test.each([
  "import './other.ts'; export const main = 1;",
  "export { other } from './other.ts'; export const main = 1;",
  "import type { Other } from './other.ts'; import './other.ts'; export type Main = Other;",
  "export type { Other } from './other.ts'; export { other } from './other.ts';",
  "import { type Other } from './other.ts'; export type Main = Other;",
])("retains static runtime cycles: %s", async (first) => {
  const result = await diagnose(
    first,
    "import './main.ts'; export interface Other {} export const other = 1;",
  );
  expect(
    result.diagnostics.filter((d) => d.ruleId === "workspace/dead-code/circular-dependency"),
  ).toHaveLength(1);
});

test("type dependencies remain reachable for dead-code analysis", async () => {
  const result = await diagnose(
    "import type { Other } from './other.ts'; export type Main = Other;",
    "export interface Other { name: string }",
    "dead-code",
  );
  expect(result.diagnostics.filter((d) => d.ruleId === "workspace/dead-code/unused-file")).toEqual(
    [],
  );
});
