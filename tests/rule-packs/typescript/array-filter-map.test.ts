import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.js";
import { noArrayFilterMap, typescriptRulePack } from "../../../src/rule-packs/typescript/index.js";
import { getRuleDocuments, getDiagnosticDocuments } from "../../../docs/rules/source.js";

const cases: [string, string, number][] = [
  [
    "value Array parameter",
    "function f(Array: unknown, values: Array<number>) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "value ReadonlyArray declaration",
    "const ReadonlyArray = 1; function f(values: ReadonlyArray<number>) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "outer type shadow with inner value",
    "type Array<T> = Custom; function f(Array: unknown, values: Array<number>) { return values.filter(keep).map(transform) }",
    0,
  ],
  [
    "generic Array shadow",
    "function f<Array>(values: Array<number>) { return values.filter(keep).map(transform) }",
    0,
  ],
  [
    "class Array shadow",
    "class Array<T> {} function f(values: Array<number>) { return values.filter(keep).map(transform) }",
    0,
  ],
  [
    "namespace Array preserves global type",
    "export {}; namespace Local { namespace Array { export const value = 1 } function f(values: Array<number>) { return values.filter(keep).map(transform) } }",
    1,
  ],
  [
    "namespace ReadonlyArray preserves global type",
    "export {}; namespace Local { namespace ReadonlyArray { export const value = 1 } function f(values: ReadonlyArray<number>) { return values.filter(keep).map(transform) } }",
    1,
  ],
  [
    "namespace merged with class still shadows type",
    "export {}; class Array<T> {} namespace Array { export const value = 1 } function f(values: Array<number>) { return values.filter(keep).map(transform) }",
    0,
  ],
  [
    "namespace merged with interface still shadows type",
    "export {}; interface ReadonlyArray<T> { custom: T } namespace ReadonlyArray { export const value = 1 } function f(values: ReadonlyArray<number>) { return values.filter(keep).map(transform) }",
    0,
  ],
  [
    "defaulted array parameter",
    "function f(values: number[] = []) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "defaulted tuple parameter",
    "function f(values: [number] = [1]) { return values.map(transform).filter(keep) }",
    1,
  ],
  [
    "defaulted destructured element is not an array",
    "function f([value = 1]: number[] = []) { return value.filter(keep).map(transform) }",
    0,
  ],
  [
    "rest array",
    "function f(...values: number[]) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "rest tuple",
    "function f(...values: [number, number]) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "parenthesized array",
    "function f(values: (number[])) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "parenthesized tuple",
    "function f(values: ([number])) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "annotated hoisted var",
    "function f() { values.filter(keep).map(transform); var values: number[] = input }",
    0,
  ],
  ["uninitialized local", "let values: number[]; values.filter(keep).map(transform)", 0],
  [
    "initialized annotated local",
    "const values: number[] = input; values.filter(keep).map(transform)",
    1,
  ],
  ["self initializer", "const values: number[] = values.filter(keep).map(transform)", 0],

  ["literal", "[1, 2].filter(keep).map(transform)", 1],
  ["reverse", "[1, 2].map(transform).filter(keep)", 1],
  ["const alias", "const values = [1]; const alias = values; alias.filter(keep).map(transform)", 1],
  [
    "typed parameter",
    "function f(values: number[]) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "readonly array",
    "function f(values: ReadonlyArray<number>) { return values.filter(keep).map(transform) }",
    1,
  ],
  [
    "readonly tuple",
    "function f(values: readonly [number, number]) { return values.filter(keep).map(transform) }",
    1,
  ],
  ["array chain", "[1, 2].slice().filter(keep).map(transform)", 1],
  ["computed method", "[1, 2]['filter'](keep)['map'](transform)", 1],
  ["iterator", "[1, 2].values().filter(keep).map(transform).toArray()", 0],
  ["factory", "loadValues().filter(keep).map(transform)", 0],
  ["untyped parameter", "function f(values) { return values.filter(keep).map(transform) }", 0],
  [
    "shadowed alias",
    "const values = [1]; function f(values) { return values.filter(keep).map(transform) }",
    0,
  ],
  ["reassigned alias", "let values = [1]; values = input; values.filter(keep).map(transform)", 0],
  [
    "type alias",
    "type Values = number[]; function f(values: Values) { return values.filter(keep).map(transform) }",
    0,
  ],
  [
    "shadowed Array",
    "type Array<T> = Custom; function f(values: Array<number>) { return values.filter(keep).map(transform) }",
    0,
  ],
  [
    "member type",
    "function f(value: { values: number[] }) { return value.values.filter(keep).map(transform) }",
    0,
  ],
  ["asserted array", "(input as number[]).filter(keep).map(transform)", 0],
  ["single pass", "[1, 2].flatMap(transform)", 0],
  [
    "loop shadowing",
    "const values = [1]; for (const values of sources) { values.filter(keep).map(transform) }",
    0,
  ],
  [
    "catch shadowing",
    "const values = [1]; try {} catch (values) { values.filter(keep).map(transform) }",
    0,
  ],
  [
    "var hoisting",
    "const values = [1]; function f() { values.filter(keep).map(transform); if (ready) { var values = input } }",
    0,
  ],
];

test.each(cases)("checks %s", async (_name, source, expected) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noArrayFilterMap],
    files: { "index.ts": source },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(Array(expected).fill("TS0012"));
});

test("exports an opt-in rule with generated rule and diagnostic documentation", () => {
  expect(typescriptRulePack.presets.strict).toContain(noArrayFilterMap.meta.id);
  expect(typescriptRulePack.presets.recommended).not.toContain(noArrayFilterMap.meta.id);
  expect(
    getRuleDocuments().find((rule) => rule.id === noArrayFilterMap.meta.id)?.examples.length,
  ).toBeGreaterThan(0);
  expect(getDiagnosticDocuments().find((diagnostic) => diagnostic.code === "TS0012")?.ruleId).toBe(
    noArrayFilterMap.meta.id,
  );
});

test("reports TypeScript Vue scripts with source locations", async () => {
  const result = await runProjectFixture({
    rules: [noArrayFilterMap],
    files: {
      "App.vue":
        '<template><p>Example</p></template>\n<script setup lang="ts">\n' +
        cases[0]![1] +
        "\n</script>",
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(["TS0012"]);
  expect(result.diagnostics[0]?.range?.line).toBe(3);
});

test("leaves JavaScript-only sources outside the TypeScript Rule Pack", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noArrayFilterMap],
    files: {
      "index.js":
        "const values = [1]; values.filter(keep).map(transform); values.reduce((acc, item) => acc.concat(item), [])",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});
