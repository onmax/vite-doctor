import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { allDiagnostics, runDoctor, type DoctorRule } from "../../src/core/index.ts";
import { createDiagnosticFingerprint } from "../../src/core/internal/diagnostics.ts";
import type { Diagnostic } from "../../src/core/primitives.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";

const roots: string[] = [];
const ruleId = "workspace/dead-code/unresolved-import";

function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), "doctor-fingerprints-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "index.ts"), source);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([" ", "\n"])(
  "distinct unresolved imports have distinct fingerprints with separator %j",
  async (separator) => {
    const root = fixture(["import './missing-one';", "import './missing-two';"].join(separator));
    const result = await runDoctor({ root, analyses: "dead-code", cache: false });
    const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.ruleId === ruleId);
    expect(diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
      'Import "./missing-one" could not be resolved.',
      'Import "./missing-two" could not be resolved.',
    ]);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.fingerprint)).size).toBe(2);
  },
);

test("a baseline for one missing import does not suppress a different missing import", async () => {
  const root = fixture("import './missing-one';");
  const options = { root, analyses: "dead-code", baseline: "baseline.json", cache: false };
  const first = await runDoctor({ ...options, updateBaseline: true });
  const original = first.diagnostics.find((diagnostic) => diagnostic.ruleId === ruleId)!;
  writeFileSync(join(root, "index.ts"), "import './missing-one'; import './missing-two';");
  const second = await runDoctor({ ...options, newOnly: true });
  expect(second.diagnostics.filter((diagnostic) => diagnostic.ruleId === ruleId)).toMatchObject([
    { why: 'Import "./missing-two" could not be resolved.' },
  ]);
  expect(
    second.suppressedDiagnostics?.filter((diagnostic) => diagnostic.ruleId === ruleId),
  ).toMatchObject([{ fingerprint: original.fingerprint, suppressionReason: "baseline" }]);
});

test("fingerprints survive repeated runs and insertion of unrelated lines", async () => {
  const root = fixture("import './missing-one';");
  const options = { root, analyses: "dead-code", cache: false };
  const fingerprints = async () =>
    (await runDoctor(options)).diagnostics
      .filter((diagnostic) => diagnostic.ruleId === ruleId)
      .map((diagnostic) => diagnostic.fingerprint);
  const original = await fingerprints();
  expect(original).toHaveLength(1);
  expect(original[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(await fingerprints()).toEqual(original);
  writeFileSync(join(root, "index.ts"), "// unrelated heading\n\nimport './missing-one';");
  expect(await fingerprints()).toEqual(original);
});

const crossFileRuleId = "test/cross-file-anchor";
const target = "export function target() {\n  return 1;\n}\n";
const targetOffset = target.indexOf("return");

function crossFileRule(execution: "file" | "manifest" | "workspace", reported: string): DoctorRule {
  return createRule({
    meta: {
      id: crossFileRuleId,
      title: "Report into another file",
      category: "architecture",
      severity: "warn",
      execution,
      reportScope: "project",
    },
    create(ctx) {
      const report = () =>
        ctx.report(
          allDiagnostics.DOC9999({ why: "Cross-file finding.", fix: "Review the target file." }),
          {
            file: join(ctx.project.root, reported),
            range: { start: targetOffset, end: targetOffset + 6, line: 2, column: 3 },
          },
        );
      if (execution !== "file") return { onProjectStart: report };
      if (ctx.file.relativePath === "a.ts") report();
      return undefined;
    },
  });
}

async function crossFileFingerprint(root: string, rule: DoctorRule) {
  const result = await runDoctor({
    root,
    cache: false,
    rules: crossFileRuleId,
    extensions: [
      defineDoctorExtension({
        name: "test/cross-file",
        rulePacks: [
          defineRulePack({
            name: "test/cross-file",
            version: "0.0.0",
            rules: [rule],
            presets: { recommended: [crossFileRuleId] },
          }),
        ],
      }),
    ],
  });
  const diagnostics = result.diagnostics.filter(
    (diagnostic) => diagnostic.ruleId === crossFileRuleId,
  );
  expect(diagnostics).toHaveLength(1);
  return diagnostics[0]!.fingerprint;
}

test.each([
  ["manifest", "b.ts"],
  ["workspace", "b.ts"],
  ["file", "b.ts"],
  ["manifest", "missing.ts"],
] as const)(
  "%s Rule reporting into %s anchors its fingerprint outside the first scanned file",
  async (execution, reported) => {
    const root = fixture("export const alpha = 1;\n");
    writeFileSync(join(root, "a.ts"), "export const zeta = 0;\n");
    writeFileSync(join(root, "b.ts"), target);
    const rule = crossFileRule(execution, reported);
    const original = await crossFileFingerprint(root, rule);
    writeFileSync(join(root, "index.ts"), "export function other() {}\nexport const beta = 2;\n");
    writeFileSync(join(root, "a.ts"), "export function first() {}\nexport const gamma = 3;\n");
    expect(await crossFileFingerprint(root, rule)).toBe(original);
  },
);

test("a cross-file report and a same-file report at one location share a fingerprint", async () => {
  const root = fixture("export const alpha = 1;\n");
  writeFileSync(join(root, "a.ts"), "export const beta = 2;\n");
  writeFileSync(join(root, "b.ts"), target);
  const fromOtherFile = await crossFileFingerprint(root, crossFileRule("file", "b.ts"));
  const sameFile = createRule({
    ...crossFileRule("file", "b.ts"),
    create(ctx) {
      if (ctx.file.relativePath !== "b.ts") return undefined;
      ctx.report(
        allDiagnostics.DOC9999({ why: "Cross-file finding.", fix: "Review the target file." }),
        { range: { start: targetOffset, end: targetOffset + 6, line: 2, column: 3 } },
      );
      return undefined;
    },
  });
  expect(await crossFileFingerprint(root, sameFile)).toBe(fromOtherFile);
});

const parseRuleId = "test/colliding-anchor";

function parseRule(reportsPerMatch = 1): DoctorRule {
  return createRule({
    meta: {
      id: parseRuleId,
      title: "Report every JSON.parse call",
      category: "correctness",
      severity: "warn",
      execution: "file",
    },
    create(ctx) {
      for (const match of ctx.file.text.matchAll(/JSON\.parse/g)) {
        const start = match.index;
        const line = ctx.file.text.slice(0, start).split("\n").length;
        for (let count = 0; count < reportsPerMatch; count++) {
          ctx.report(
            allDiagnostics.DOC9999({
              why: "JSON.parse result is cast without validation.",
              fix: "Validate the parsed value.",
            }),
            { range: { start, end: start + match[0].length, line, column: 1 } },
          );
        }
      }
      return undefined;
    },
  });
}

async function parseDiagnostics(
  root: string,
  options: {
    rule?: DoctorRule;
    baseline?: string;
    updateBaseline?: boolean;
    newOnly?: boolean;
  } = {},
) {
  const { rule = parseRule(), ...runOptions } = options;
  const result = await runDoctor({
    root,
    cache: false,
    rules: parseRuleId,
    ...runOptions,
    extensions: [
      defineDoctorExtension({
        name: "test/colliding-anchor",
        rulePacks: [
          defineRulePack({
            name: "test/colliding-anchor",
            version: "0.0.0",
            rules: [rule],
            presets: { recommended: [parseRuleId] },
          }),
        ],
      }),
    ],
  });
  const pick = (diagnostics: Diagnostic[] | undefined) =>
    (diagnostics ?? []).filter((diagnostic) => diagnostic.ruleId === parseRuleId);
  return { diagnostics: pick(result.diagnostics), suppressed: pick(result.suppressedDiagnostics) };
}

const users = (input: string) => `  const users = JSON.parse(${input}) as string[];`;
const loader = (name: string, input: string) =>
  [`export function ${name}(${input}: string) {`, users(input), "  return users;", "}", ""].join(
    "\n",
  );
const colliding = loader("load", "a") + loader("reload", "b");

test("distinct findings with the same anchor are all reported with distinct fingerprints", async () => {
  const root = fixture(colliding);
  const { diagnostics } = await parseDiagnostics(root);
  expect(diagnostics.map((diagnostic) => diagnostic.range?.line)).toEqual([2, 6]);
  expect(new Set(diagnostics.map((diagnostic) => diagnostic.fingerprint)).size).toBe(2);
});

test("the first colliding finding keeps its anchor fingerprint", async () => {
  const root = fixture(colliding);
  const { diagnostics } = await parseDiagnostics(root);
  const legacy = createDiagnosticFingerprint(root, diagnostics[0]!, colliding);
  expect(createDiagnosticFingerprint(root, diagnostics[1]!, colliding)).toBe(legacy);
  expect(diagnostics[0]!.fingerprint).toBe(legacy);
  expect(diagnostics[1]!.fingerprint).not.toBe(legacy);
});

test("colliding fingerprints survive edits to unrelated earlier lines", async () => {
  const root = fixture(colliding);
  const original = (await parseDiagnostics(root)).diagnostics.map((item) => item.fingerprint);
  const edited = colliding.replace("return users;", "return users.slice();");
  writeFileSync(join(root, "index.ts"), `// heading\nexport const version = 2;\n\n${edited}`);
  const next = (await parseDiagnostics(root)).diagnostics;
  expect(next.map((item) => item.range?.line)).toEqual([5, 9]);
  expect(next.map((item) => item.fingerprint)).toEqual(original);
});

test("the same finding reported twice is still deduplicated", async () => {
  const root = fixture(colliding);
  const { diagnostics } = await parseDiagnostics(root, { rule: parseRule(2) });
  expect(diagnostics.map((diagnostic) => diagnostic.range?.line)).toEqual([2, 6]);
  expect(new Set(diagnostics.map((diagnostic) => diagnostic.fingerprint)).size).toBe(2);
});

test("--new-only reports only the unbaselined finding among colliding fingerprints", async () => {
  const root = fixture(loader("load", "a"));
  const options = { baseline: "baseline.json" };
  const first = await parseDiagnostics(root, { ...options, updateBaseline: true });
  expect(first.diagnostics).toHaveLength(1);
  writeFileSync(join(root, "index.ts"), colliding);
  const second = await parseDiagnostics(root, { ...options, newOnly: true });
  expect(second.diagnostics).toMatchObject([{ range: { line: 6 } }]);
  expect(second.suppressed).toMatchObject([
    {
      range: { line: 2 },
      fingerprint: first.diagnostics[0]!.fingerprint,
      suppressionReason: "baseline",
    },
  ]);
});
