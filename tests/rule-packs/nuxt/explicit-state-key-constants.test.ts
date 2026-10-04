import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferExplicitUseStateKeyInExportedComposables } from "../../../src/rule-packs/nuxt/rules/nuxt/prefer-explicit-use-state-key-in-exported-composables.ts";

test.each([
  'const value = <string>input; const KEY = "counter"; export function useCounter() { return useState(KEY, () => 0) }',
  'const KEY = <string>"counter"; export function useCounter() { return useState(KEY, () => 0) }',
  'const KEY = "counter"; export function useCounter() { return useState(KEY, () => 0) }',
  'export const KEY = "counter"; export const useCounter = () => useState(KEY, () => 0)',
  'export function useCounter() { const key = "counter"; return useState(key, () => 0) }',
  'const key = "counter"; const alias = key; export function useCounter() { return useState(alias, () => 0) }',
  "const key = `counter`; export function useCounter() { return useState(key, () => 0) }",
  "export function useCounter() { return useState(`counter`, () => 0) }",
  'const key = "counter" as const; export function useCounter() { return useState(key, () => 0) }',
  'const key = "counter" satisfies string; export function useCounter() { return useState(key, () => 0) }',
  'const prefix = "counter"; const key = prefix + ":count"; export function useCounter() { return useState(key, () => 0) }',
])("accepts explicit constant state keys: %s", async (source) => {
  const result = await runRuleFixture({
    rule: preferExplicitUseStateKeyInExportedComposables,
    framework: "nuxt",
    files: { "app/composables/useCounter.ts": source },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "export function useCounter() { return useState(() => 0) }",
  "const key = () => 0; export function useCounter() { return useState(key) }",
  'const key = "counter"; export function useCounter(key) { return useState(key, () => 0) }',
  'let key = "counter"; key = getKey(); export function useCounter() { return useState(key, () => 0) }',
  "const key = getKey(); export function useCounter() { return useState(key, () => 0) }",
  "const first = second; const second = first; export function useCounter() { return useState(first, () => 0) }",
])("preserves diagnostics when no constant string key is proven: %s", async (source) => {
  const result = await runRuleFixture({
    rule: preferExplicitUseStateKeyInExportedComposables,
    framework: "nuxt",
    files: { "app/composables/useCounter.ts": source },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([
    preferExplicitUseStateKeyInExportedComposables.meta.id,
  ]);
});
