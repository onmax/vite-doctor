import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { applyDiagnosticPolicy } from "../../src/core/internal/diagnostic-policy.ts";
import { normalizeDiagnosticFromRuleCode } from "../../src/core/internal/diagnostics.ts";

const roots: string[] = [];

function fixture(text?: string, filename = "app.ts") {
  const root = mkdtempSync(join(tmpdir(), "doctor-policy-"));
  roots.push(root);
  const file = join(root, filename);
  if (text !== undefined) writeFileSync(file, text);
  return { root, file };
}

function finding(file: string, line?: number) {
  return normalizeDiagnosticFromRuleCode({
    code: "DOC9999",
    ruleId: "test/example",
    severity: "warn",
    category: "correctness",
    why: "Fixture diagnostic.",
    suggestion: "Fix the fixture.",
    file,
    range: line === undefined ? undefined : { start: 0, end: 1, line, column: 1 },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([1, 2, 4])("next-line suppression does not hide a diagnostic on line %i", (line) => {
  const { root, file } = fixture(
    [
      "const before = 1;",
      "// doctor-disable-next-line test/example -- intentional fixture",
      "const ignored = 2;",
      "const after = 3;",
    ].join("\n"),
  );
  const diagnostic = finding(file, line);
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [diagnostic],
  });
  expect(result.diagnostics).toEqual([diagnostic]);
  expect(result.suppressedDiagnostics).toEqual([]);
});

test.each(["\n", "\r\n"])("next-line suppression applies to its target line with %j", (newline) => {
  const { root, file } = fixture(
    ["// doctor-disable-next-line test/example -- intentional fixture", "const ignored = 2;"].join(
      newline,
    ),
  );
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 2)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { suppressionReason: "intentional fixture" },
  ]);
});

test("an unrelated directive does not mask the next-line suppression for this rule", () => {
  const { root, file } = fixture(
    [
      "// doctor-disable-next-line test/unrelated -- another diagnostic",
      "// doctor-disable-next-line test/example -- intentional fixture",
      "const ignored = 2;",
    ].join("\n"),
  );
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 3)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { suppressionReason: "intentional fixture" },
  ]);
});

test("next-line suppression does not hide a diagnostic without a source range", () => {
  const { root, file } = fixture(
    "// doctor-disable-next-line * -- intentional fixture\nconst ignored = 2;",
  );
  const diagnostic = finding(file);
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [diagnostic],
  });
  expect(result.diagnostics).toEqual([diagnostic]);
});

test("diagnostics for missing source files remain reportable", () => {
  const { root, file } = fixture();
  const diagnostic = finding(file);
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [diagnostic],
  });
  expect(result.diagnostics).toEqual([diagnostic]);
});

test("configured suppressions still apply to missing source files", () => {
  const { root, file } = fixture();
  const result = applyDiagnosticPolicy({
    root,
    config: { suppressions: [{ ruleId: "test/example", reason: "generated source" }] },
    options: {},
    diagnostics: [finding(file)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ suppressionReason: "generated source" }]);
});

test("plain inline suppressions still apply to nearby diagnostics", () => {
  const { root, file } = fixture(
    "const ignored = 2; // doctor-disable test/example -- intentional fixture",
  );
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 1)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { suppressionReason: "intentional fixture" },
  ]);
});

test("line comment suppressions may omit whitespace after the delimiter", () => {
  const { root, file } = fixture(
    "const ignored = 2; //doctor-disable test/example -- intentional fixture",
  );
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 1)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { suppressionReason: "intentional fixture" },
  ]);
});

test("suppression text inside string literals does not hide diagnostics", () => {
  const { root, file } = fixture(
    'const text = "doctor-disable test/example -- this is data";\nconst value = 1;',
  );
  const diagnostic = finding(file, 1);
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [diagnostic],
  });
  expect(result.diagnostics).toEqual([diagnostic]);
  expect(result.suppressedDiagnostics).toEqual([]);
});

test.each([
  "const text = `\n// doctor-disable test/example -- template data\n`;\nconst value = 1;",
  "const pattern = /\\/\\/ doctor-disable test\\/example -- regex/;\nconst value = 1;",
])("suppression text inside multiline literals does not hide diagnostics", (text) => {
  const { root, file } = fixture(text);
  const diagnostic = finding(file, 1);
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [diagnostic],
  });
  expect(result.diagnostics).toEqual([diagnostic]);
  expect(result.suppressedDiagnostics).toEqual([]);
});

test("multiline block comments map directives to their source line", () => {
  const block = fixture(
    "/*\n * doctor-disable test/example -- block reason\n */\nconst value = 1;",
  );
  const result = applyDiagnosticPolicy({
    root: block.root,
    config: {},
    options: {},
    diagnostics: [finding(block.file, 4)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ suppressionReason: "block reason" }]);
});

test("one-line block comment suppressions exclude the closing delimiter", () => {
  const { root, file } = fixture(
    "const value = 1; /* doctor-disable test/example -- block reason */",
  );
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 1)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ suppressionReason: "block reason" }]);
});

test("HTML comments in Vue SFCs support suppressions", () => {
  const { root, file } = fixture(
    [
      "<template>",
      "  <!-- doctor-disable test/example -- html reason -->",
      "  <div />",
      "</template>",
      '<script setup lang="ts">',
      "const value = 1;",
      "</script>",
    ].join("\n"),
    "app.vue",
  );
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 3)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ suppressionReason: "html reason" }]);
});

test("multiline Vue HTML next-line suppressions target the following source line", () => {
  const { root, file } = fixture(
    [
      "<template>",
      "  <!--",
      "    doctor-disable-next-line test/example -- html next line",
      "  --><div />",
      "</template>",
    ].join("\n"),
    "app.vue",
  );
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 4)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ suppressionReason: "html next line" }]);
});

test("comment-like HTML text in a Vue script string does not suppress diagnostics", () => {
  const { root, file } = fixture(
    [
      '<script setup lang="ts">',
      'const text = "<!-- doctor-disable test/example -- data -->";',
      "const value = 1;",
      "</script>",
    ].join("\n"),
    "app.vue",
  );
  const diagnostic = finding(file, 3);
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [diagnostic],
  });
  expect(result.diagnostics).toEqual([diagnostic]);
  expect(result.suppressedDiagnostics).toEqual([]);
});

test("suppression text in a Vue template literal does not suppress diagnostics", () => {
  const { root, file } = fixture(
    [
      '<script setup lang="ts">',
      "const text = `",
      "// doctor-disable test/example -- template data",
      "`;",
      "const value = 1;",
      "</script>",
    ].join("\n"),
    "app.vue",
  );
  const diagnostic = finding(file, 5);
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [diagnostic],
  });
  expect(result.diagnostics).toEqual([diagnostic]);
  expect(result.suppressedDiagnostics).toEqual([]);
});

test("Vue script next-line suppression applies to the following source line", () => {
  const { root, file } = fixture(
    [
      '<script setup lang="ts">',
      "// doctor-disable-next-line test/example -- next line",
      "const value = 1;",
      "</script>",
    ].join("\n"),
    "app.vue",
  );
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 3)],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ suppressionReason: "next line" }]);
});

test("a suppression without a reason does not consume the next source line as its reason", () => {
  const { root, file } = fixture("// doctor-disable-next-line test/example\nconst ignored = 2;");
  const result = applyDiagnosticPolicy({
    root,
    config: {},
    options: {},
    diagnostics: [finding(file, 2)],
  });
  expect(result.suppressedDiagnostics).toMatchObject([
    { suppressionReason: "missing suppression reason" },
  ]);
});

test("removing a suppression is reflected in the next Doctor policy pass", () => {
  const { root, file } = fixture(
    "// doctor-disable-next-line test/example -- intentional fixture\nconst ignored = 2;",
  );
  const diagnostic = finding(file, 2);
  const input = { root, config: {}, options: {}, diagnostics: [diagnostic] };
  expect(applyDiagnosticPolicy(input).suppressedDiagnostics).toHaveLength(1);
  writeFileSync(file, "// suppression removed\nconst ignored = 2;");
  expect(applyDiagnosticPolicy(input).diagnostics).toEqual([diagnostic]);
});
