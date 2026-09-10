import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.js";
import {
  noReduceAccumulatorCopy,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.js";
import { getRuleDocuments, getDiagnosticDocuments } from "../../../docs/rules/source.js";

const cases: [string, string, number][] = [
  ["concat", "items.reduce((acc, item) => acc.concat([item]), [])", 1],
  [
    "slice alias",
    "items.reduce((acc, item) => { const alias = acc; const next = alias.slice(); next.push(item); return next }, [])",
    1,
  ],
  [
    "Object.assign",
    "items.reduce((acc, item) => Object.assign({}, acc, { [item.id]: item }), {})",
    1,
  ],
  ["Array.from", "items.reduce((acc, item) => Array.from(acc), [])", 1],
  ["reduceRight", "items.reduceRight((acc, item, index) => acc.toSpliced(index, 0, item), [])", 1],
  [
    "array initializer alias",
    "const initial = []; items.reduce((acc, item) => acc.concat([item]), initial)",
    1,
  ],
  ["fresh mutation", "items.reduce((acc, item) => { acc.push(item); return acc }, [])", 0],
  ["in place assign", "items.reduce((acc, item) => Object.assign(acc, item), {})", 0],
  ["string concat", "items.reduce((acc, item) => acc.concat(item), '')", 0],
  ["unknown initial", "items.reduce((acc, item) => acc.slice(), initial)", 0],
  [
    "shadowed Object",
    "function f(Object) { return items.reduce((acc, item) => Object.assign({}, acc, item), {}) }",
    0,
  ],
  [
    "shadowed Array",
    "function f(Array) { return items.reduce((acc, item) => Array.from(acc), []) }",
    0,
  ],
  [
    "nested callback",
    "items.reduce((acc, item) => { function copy() { return acc.slice() } return acc }, [])",
    0,
  ],
  [
    "named callback",
    "const callback = (acc, item) => acc.concat(item); items.reduce(callback, [])",
    0,
  ],
  ["input copies", "items.reduce((acc, item) => { const copy = item.slice(); return acc }, [])", 0],
  [
    "reassigned accumulator",
    "items.reduce((acc, item) => { acc = item; return acc.slice() }, [])",
    0,
  ],
  [
    "shadowed alias",
    "items.reduce((acc, item) => { const alias = acc; { const alias = item; alias.slice() } return acc }, [])",
    0,
  ],
  ["no initial", "items.reduce((acc, item) => acc.slice())", 0],
];

test.each(cases)("checks %s", async (_name, source, expected) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noReduceAccumulatorCopy],
    files: { "index.ts": source },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(Array(expected).fill("TS0010"));
});

test("exports an opt-in rule with generated rule and diagnostic documentation", () => {
  expect(typescriptRulePack.presets.strict).toContain(noReduceAccumulatorCopy.meta.id);
  expect(typescriptRulePack.presets.recommended).not.toContain(noReduceAccumulatorCopy.meta.id);
  expect(
    getRuleDocuments().find((rule) => rule.id === noReduceAccumulatorCopy.meta.id)?.examples.length,
  ).toBeGreaterThan(0);
  expect(getDiagnosticDocuments().find((diagnostic) => diagnostic.code === "TS0010")?.ruleId).toBe(
    noReduceAccumulatorCopy.meta.id,
  );
});

test("reports TypeScript Vue scripts with source locations", async () => {
  const result = await runProjectFixture({
    rules: [noReduceAccumulatorCopy],
    files: {
      "App.vue":
        '<template><p>Example</p></template>\n<script setup lang="ts">\n' +
        cases[0]![1] +
        "\n</script>",
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(["TS0010"]);
  expect(result.diagnostics[0]?.range?.line).toBe(3);
});

test("leaves JavaScript-only sources outside the TypeScript Rule Pack", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noReduceAccumulatorCopy],
    files: {
      "index.js":
        "const values = [1]; values.filter(keep).map(transform); values.reduce((acc, item) => acc.concat(item), [])",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});
