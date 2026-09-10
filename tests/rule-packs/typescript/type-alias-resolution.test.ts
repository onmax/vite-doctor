import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.js";
import {
  noObjectParameters,
  noUnknownTypeAliases,
} from "../../../src/rule-packs/typescript/index.js";

const cases: [string, string, number][] = [
  [
    "block forward aliases",
    "function outer() { function save(value: Input) {} type Input = object }",
    1,
  ],
  ["generic aliases", "type Identity<T> = T; function save(value: Identity<object>) {}", 1],
  [
    "nested generic aliases",
    "type Identity<T> = T; function save(value: Identity<Identity<object>>) {}",
    1,
  ],
  ["default parameters", "type Identity<T = object> = T; function save(value: Identity) {}", 1],
  ["dependent defaults", "type Choose<T, U = T> = U; function save(value: Choose<object>) {}", 1],
  [
    "shadowed aliases",
    "type Input = object; function outer() { type Input = { id: string }; function save(value: Input) {} }",
    0,
  ],
  ["type parameter shadowing", "type Input = object; function save<Input>(value: Input) {}", 0],
  [
    "interface shadowing",
    "type Input = object; function outer() { interface Input { id: string }; function save(value: Input) {} }",
    0,
  ],
  [
    "alias declaration scope",
    "type Input = object; type Alias = Input; function outer() { type Input = string; function save(value: Alias) {} }",
    1,
  ],
  [
    "substitution declaration scope",
    "type T = object; type Identity<T> = T; function save(value: Identity<T>) {}",
    1,
  ],
  [
    "generic parameter capture",
    "type T = object; type Outer<X> = T; type Identity<T> = Outer<T>; function save(value: Identity<string>) {}",
    1,
  ],
  [
    "type alias and namespace coexistence",
    "type Input = object; namespace Input { export const tag = 1 } function save(value: Input) {}",
    1,
  ],
  [
    "namespace before type alias",
    "namespace Input { export const tag = 1 } type Input = object; function save(value: Input) {}",
    1,
  ],
  [
    "namespace does not shadow outer type alias",
    "type Input = object; namespace Container { namespace Input { export const tag = 1 } function save(value: Input) {} }",
    1,
  ],
  [
    "unknown alias and namespace coexistence",
    "type Raw = unknown; namespace Raw { export const tag = 1 } type Copy = Raw;",
    2,
  ],
  [
    "competing type declarations remain ambiguous",
    "type Input = object; interface Input {} namespace Input { export const tag = 1 } function save(value: Input) {}",
    0,
  ],
  ["cycles", "type A = B; type B = A; function save(value: A) {}", 0],
  ["imports", "import type { Input } from 'external'; function save(value: Input) {}", 0],
  ["block unknown alias", "function outer() { type Raw = unknown }", 1],
  ["instantiated unknown alias", "type Identity<T> = T; type Raw = Identity<unknown>", 1],
  ["uninstantiated default", "type Identity<T = unknown> = T", 0],
  ["unknown independent of parameter", "type Raw<T> = unknown", 1],
  [
    "namespace aliases",
    "namespace Internal { type Input = object; function save(value: Input) {} }",
    1,
  ],
];

test.each(cases)("resolves %s", async (_name, source, expected) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noObjectParameters, noUnknownTypeAliases],
    files: { "index.ts": source },
  });
  expect(result.diagnostics).toHaveLength(expected);
});

test("resolves aliases in TypeScript Vue scripts", async () => {
  const result = await runProjectFixture({
    rules: [noObjectParameters],
    files: {
      "App.vue":
        '<script setup lang="ts">type Identity<T> = T; function save(value: Identity<object>) {}</script>',
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(["TS0002"]);
});
