import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.js";
import {
  noKnownValueWidening,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.js";
import { getRuleDocuments, getDiagnosticDocuments } from "../../../docs/rules/source.js";

const cases: [string, string, number][] = [
  ["unknown object", "const value: unknown = { id: 1 }", 1],
  ["known keys", "const handlers: Record<string, Handler> = { start: startHandler }", 1],
  ["rest parameter", "function f(...values: string[]) { const erased: unknown = values }", 1],
  ["default parameter", "function f(values: string[] = []) { const erased: unknown = values }", 1],
  ["untyped default", "function f(values = load()) { const erased: unknown = values }", 0],
  [
    "destructured parameter",
    "function f({ value }: { value: unknown }) { const erased: unknown = value }",
    0,
  ],
  ["const assertion", "const erased: unknown = { id: 1 } as const", 1],
  ["angle assertion", "const erased: unknown = <{ id: number }>{ id: 1 }", 1],
  ["asserted runtime call", "const erased: unknown = load() as { id: number }", 0],
  [
    "asserted import",
    "import { value } from './external'; const erased: unknown = value as number",
    0,
  ],
  ["asserted empty accumulator", "const erased: Record<string, unknown> = {} as const", 0],
  ["negative literal", "const erased: unknown = -1", 1],
  ["negative bigint", "const erased: unknown = -1n", 1],
  ["bigint plus", "const erased: unknown = +1n", 0],
  ["bigint alias plus", "const value = 1n; const erased: unknown = +value", 0],
  ["nested bigint alias plus", "const a = 1n; const b = -a; const erased: unknown = +~b", 0],
  ["bigint alias negative", "const value = 1n; const erased: unknown = -value", 1],
  ["bigint boolean conversion", "const value = 1n; const erased: unknown = +!value", 1],
  ["typed bigint plus", "function f(value: bigint) { const erased: unknown = +value }", 0],
  ["null +", "const erased: unknown = +null", 1],
  ["null alias +", "const value = null; const erased: unknown = +value", 1],
  ["null -", "const erased: unknown = -null", 1],
  ["null alias -", "const value = null; const erased: unknown = -value", 1],
  ["null ~", "const erased: unknown = ~null", 1],
  ["null alias ~", "const value = null; const erased: unknown = ~value", 1],
  ["null !", "const erased: unknown = !null", 1],
  ["null alias !", "const value = null; const erased: unknown = !value", 1],
  ["negative alias", "const value = 1; const erased: unknown = -value", 1],
  ["nested unary alias", "const value = 1; const erased: unknown = ~-value", 1],
  ["asserted unary operand", "const erased: unknown = -(1 as const)", 1],
  ["unary call alias", "const value = load(); const erased: unknown = -value", 0],
  ["unary import", "import { value } from './external'; const erased: unknown = -value", 0],
  ["unary mutable alias", "let value = 1; value = input; const erased: unknown = -value", 0],
  ["unary alias cycle", "const a = -b; const b = -a; const erased: unknown = -b", 0],
  ["unary outer alias", "const value = 1; function f() { const erased: unknown = -value }", 1],
  ["unary runtime input", "const erased: unknown = -load()", 0],
  ["primitive", "const value: unknown = 1", 1],
  ["immutable alias", "const value = [1, 2]; const erased: object = value", 1],
  ["satisfies", "const value = { id: 1 } satisfies Record<string, unknown>", 0],
  ["empty accumulator", "const value: Record<string, unknown> = {}", 0],
  ["finite keys", "const value: Record<'id', number> = { id: 1 }", 0],
  ["runtime boundary", "const value: unknown = JSON.parse(text)", 0],
  ["imported factory", "const value: unknown = loadValue()", 0],
  ["mutable input", "let value = 1; value = input; const erased: unknown = value", 0],
  ["shadowed input", "const value = 1; function f(value) { const erased: unknown = value }", 0],
  [
    "shadowed Record",
    "type Record<K,V> = { id: number }; const value: Record<string, number> = { id: 1 }",
    0,
  ],
  ["generic shadowing", "function f<Record>() { const value: Record = { id: 1 } }", 0],
  [
    "unknown alias",
    "type External = unknown; const value: External = input; const erased: unknown = value",
    0,
  ],
  ["destructured writes", "let value = 1; ({ value } = input); const erased: unknown = value", 0],
  [
    "table read with a runtime key",
    "const units: Record<string, number> = { s: 1, m: 60 }; export const f = (unit: string) => units[unit]",
    0,
  ],
  [
    "numeric table read with a runtime key",
    "const texts: Record<number, string> = { 404: 'Not found' }; export const f = (status: number) => texts[status]",
    0,
  ],
  [
    "table read with an optional runtime key",
    "const units: Record<string, number> = { s: 1 }; export const f = (unit: string) => units?.[unit]",
    0,
  ],
  [
    "table read with a runtime key in a nested function",
    "const units: Record<string, number> = { s: 1 }; function f(match: string[]) { return units[match[1]!] }",
    0,
  ],
  [
    "table read with an undeclared literal key",
    "const units: Record<string, number> = { s: 1 }; export const f = () => units.m",
    0,
  ],
  [
    "accumulator with a later member write",
    "const env: Record<string, string> = { HOME: '/' }; env.PATH = '/bin'",
    0,
  ],
  [
    "accumulator with a later computed write",
    "const env: Record<string, string> = { HOME: '/' }; export const f = (key: string) => { env[key] = '' }",
    0,
  ],
  [
    "accumulator with a later delete",
    "const env: Record<string, string> = { HOME: '/' }; delete env.HOME",
    0,
  ],
  ["exported table", "export const presets: Record<string, string> = { daily: '0 0 * * *' }", 0],
  ["reassigned let", "let hidden: Record<string, unknown> = { id: 1 }; hidden = {}", 0],
  ["let table", "let table: Record<string, number> = { a: 1 }", 0],
  [
    "table read with literal keys",
    "const names: Record<string, string> = { draft: 'a', report: 'b' }; use(names.draft, names['report'])",
    1,
  ],
  [
    "table passed whole",
    "const headers: Record<string, string> = { accept: 'json' }; fetch(url, { headers })",
    1,
  ],
  [
    "shadowed table read with a runtime key",
    "const units: Record<string, number> = { s: 1 }; function f(units: Record<string, number>, key: string) { return units[key] }",
    1,
  ],
  [
    "other object with a member write",
    "const env: Record<string, string> = { HOME: '/' }; function f(env: Record<string, string>) { env.PATH = '' }",
    1,
  ],
  ["symbol not", "function f(value: symbol) { const erased: unknown = !value;  }", 1],
  ["symbol plus", "function f(value: symbol) { const erased: unknown = +value;  }", 0],
  ["symbol negative", "function f(value: symbol) { const erased: unknown = -value;  }", 0],
  ["symbol complement", "function f(value: symbol) { const erased: unknown = ~value;  }", 0],
  [
    "symbol boolean conversion",
    "function f(value: symbol) { const erased: unknown = +!value;  }",
    1,
  ],
  ["symbol throwing nested", "function f(value: symbol) { const erased: unknown = !-value;  }", 0],
  [
    "symbol alias not",
    "function f(value: symbol) { const alias = value; const erased: unknown = !alias;  }",
    1,
  ],
  [
    "symbol alias plus",
    "function f(value: symbol) { const alias = value; const erased: unknown = +alias;  }",
    0,
  ],
];

test.each(cases)("checks %s", async (_name, source, expected) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noKnownValueWidening],
    files: { "index.ts": source },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(Array(expected).fill("TS0011"));
});

test("exports an opt-in rule with generated rule and diagnostic documentation", () => {
  expect(typescriptRulePack.presets.strict).toContain(noKnownValueWidening.meta.id);
  expect(typescriptRulePack.presets.recommended).not.toContain(noKnownValueWidening.meta.id);
  expect(
    getRuleDocuments().find((rule) => rule.id === noKnownValueWidening.meta.id)?.examples.length,
  ).toBeGreaterThan(0);
  expect(getDiagnosticDocuments().find((diagnostic) => diagnostic.code === "TS0011")?.ruleId).toBe(
    noKnownValueWidening.meta.id,
  );
});

test("reports TypeScript Vue scripts with source locations", async () => {
  const result = await runProjectFixture({
    rules: [noKnownValueWidening],
    files: {
      "App.vue":
        '<template><p>Example</p></template>\n<script setup lang="ts">\n' +
        cases[0]![1] +
        "\n</script>",
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(["TS0011"]);
  expect(result.diagnostics[0]?.range?.line).toBe(3);
});

test("leaves JavaScript-only sources outside the TypeScript Rule Pack", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noKnownValueWidening],
    files: {
      "index.js":
        "const values = [1]; values.filter(keep).map(transform); values.reduce((acc, item) => acc.concat(item), [])",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("leaves Vue bindings the template reads", async () => {
  const result = await runProjectFixture({
    rules: [noKnownValueWidening],
    files: {
      "App.vue":
        '<template><p>{{ patches[path] }}</p></template>\n<script setup lang="ts">\n' +
        "const path = 'a'\nconst patches: Record<string, string> = { a: 'diff' }\n</script>",
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});
