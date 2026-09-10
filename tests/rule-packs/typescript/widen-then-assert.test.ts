import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.js";
import { noWidenThenAssert, typescriptRulePack } from "../../../src/rule-packs/typescript/index.js";
import { getRuleDocuments, getDiagnosticDocuments } from "../../../docs/rules/source.js";

const cases: [string, string, number][] = [
  [
    "annotation",
    "const value = { id: 1 }; const erased: unknown = value; const claimed = erased as User",
    1,
  ],
  [
    "assertion",
    "const value = { id: 1 }; const erased = value as unknown; const claimed = erased as User",
    1,
  ],
  [
    "alias chain",
    "const erased: object = { id: 1 }; const alias = erased; const claimed = alias as User",
    1,
  ],
  ["any", "const erased: any = [1]; const claimed = erased as string[]", 1],
  [
    "broad record",
    "const erased: Record<string, unknown> = { id: 1 }; const claimed = erased as User",
    1,
  ],
  ["same function", "function f() { const erased: unknown = { id: 1 }; return erased as User }", 1],
  [
    "outer function evidence",
    "function outer() { const value = { id: 1 }; function inner() { const erased: unknown = value; return erased as User } }",
    0,
  ],
  [
    "outer evidence through local alias",
    "const value = { id: 1 }; function inner() { const alias = value; const erased = alias as unknown; return erased as User }",
    0,
  ],
  [
    "outer annotated evidence",
    "function outer(value: string) { return () => { const erased: unknown = value; return erased as User } }",
    0,
  ],
  [
    "same function evidence aliases",
    "function inner() { const value = { id: 1 }; const alias = value; const erased = alias as unknown; return erased as User }",
    1,
  ],
  [
    "same function block evidence",
    "function inner(value: string) { { const erased: unknown = value; return erased as User } }",
    1,
  ],
  ["boundary", "const erased: unknown = JSON.parse(text); const claimed = erased as User", 0],
  [
    "imported value",
    "import { value } from 'external'; const erased: unknown = value; const claimed = erased as User",
    0,
  ],
  [
    "mutable binding",
    "let erased: unknown = { id: 1 }; erased = input; const claimed = erased as User",
    0,
  ],
  ["closure", "const erased: unknown = { id: 1 }; function get() { return erased as User }", 0],
  [
    "shadowing",
    "const erased: unknown = { id: 1 }; function get(erased: unknown) { return erased as User }",
    0,
  ],
  ["broad target", "const erased: unknown = { id: 1 }; const claimed = erased as object", 0],
  ["const target", "const erased: unknown = { id: 1 }; const claimed = erased as const", 0],
  ["no widening", "const value = { id: 1 }; const claimed = value as User", 0],
  [
    "unresolved alias",
    "type External = unknown; const value: External = input; const erased: unknown = value; const claimed = erased as User",
    0,
  ],
  [
    "symbol not",
    "function f(value: symbol) { const erased: unknown = !value; return erased as boolean }",
    1,
  ],
  [
    "symbol plus",
    "function f(value: symbol) { const erased: unknown = +value; return erased as boolean }",
    0,
  ],
  [
    "symbol negative",
    "function f(value: symbol) { const erased: unknown = -value; return erased as boolean }",
    0,
  ],
  [
    "symbol complement",
    "function f(value: symbol) { const erased: unknown = ~value; return erased as boolean }",
    0,
  ],
  [
    "symbol boolean conversion",
    "function f(value: symbol) { const erased: unknown = +!value; return erased as boolean }",
    1,
  ],
  [
    "symbol throwing nested",
    "function f(value: symbol) { const erased: unknown = !-value; return erased as boolean }",
    0,
  ],
  [
    "symbol alias not",
    "function f(value: symbol) { const alias = value; const erased: unknown = !alias; return erased as boolean }",
    1,
  ],
  [
    "symbol alias plus",
    "function f(value: symbol) { const alias = value; const erased: unknown = +alias; return erased as boolean }",
    0,
  ],
];

test.each(cases)("checks %s", async (_name, source, expected) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noWidenThenAssert],
    files: { "index.ts": source },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(Array(expected).fill("TS0009"));
});

test("exports an opt-in rule with generated rule and diagnostic documentation", () => {
  expect(typescriptRulePack.presets.strict).toContain(noWidenThenAssert.meta.id);
  expect(typescriptRulePack.presets.recommended).not.toContain(noWidenThenAssert.meta.id);
  expect(
    getRuleDocuments().find((rule) => rule.id === noWidenThenAssert.meta.id)?.examples.length,
  ).toBeGreaterThan(0);
  expect(getDiagnosticDocuments().find((diagnostic) => diagnostic.code === "TS0009")?.ruleId).toBe(
    noWidenThenAssert.meta.id,
  );
});

test("reports TypeScript Vue scripts with source locations", async () => {
  const result = await runProjectFixture({
    rules: [noWidenThenAssert],
    files: {
      "App.vue":
        '<template><p>Example</p></template>\n<script setup lang="ts">\n' +
        cases[0]![1] +
        "\n</script>",
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(["TS0009"]);
  expect(result.diagnostics[0]?.range?.line).toBe(3);
});

test("leaves JavaScript-only sources outside the TypeScript Rule Pack", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noWidenThenAssert],
    files: {
      "index.js":
        "const values = [1]; values.filter(keep).map(transform); values.reduce((acc, item) => acc.concat(item), [])",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});
