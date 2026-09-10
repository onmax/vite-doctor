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
  [
    "merged namespace exports",
    "namespace N { export type Input = object } namespace N { function save(value: Input) {} }",
    1,
  ],
  [
    "merged namespace forward exports",
    "namespace N { function save(value: Input) {} } namespace N { export type Input = object }",
    1,
  ],
  [
    "merged namespace private aliases",
    "namespace N { type Input = object } namespace N { function save(value: Input) {} }",
    0,
  ],
  [
    "merged namespace private shadowing",
    "namespace N { export type Input = object } namespace N { type Input = string; function save(value: Input) {} }",
    0,
  ],
  [
    "merged namespace generic declaration scope",
    "namespace N { type Private = object; export type Input<T = Private> = T } namespace N { type Private = string; function save(value: Input) {} }",
    1,
  ],
  [
    "merged namespace unknown aliases",
    "namespace N { export type Raw = unknown } namespace N { type Copy = Raw }",
    2,
  ],
  [
    "qualified alias",
    "namespace N { export type Input = object } function save(value: N.Input) {}",
    1,
  ],
  [
    "qualified forward alias",
    "function save(value: N.Input) {} namespace N { export type Input = object }",
    1,
  ],
  [
    "qualified private alias",
    "namespace N { type Input = object } function save(value: N.Input) {}",
    0,
  ],
  [
    "qualified missing member",
    "type Input = object; namespace N {} function save(value: N.Input) {}",
    0,
  ],
  [
    "qualified nested namespace",
    "namespace N { export namespace M { export type Input = object } } function save(value: N.M.Input) {}",
    1,
  ],
  [
    "qualified dotted namespace",
    "namespace N.M { export type Input = object } function save(value: N.M.Input) {}",
    1,
  ],
  [
    "qualified private namespace",
    "namespace N { namespace M { export type Input = object } } function save(value: N.M.Input) {}",
    0,
  ],
  [
    "qualified namespace shadowing",
    "namespace N { export type Input = object } function outer() { namespace N {} function save(value: N.Input) {} }",
    0,
  ],
  ["qualified import", "import type * as N from 'external'; function save(value: N.Input) {}", 0],
  [
    "qualified competing declaration",
    "import type * as N from 'external'; namespace N { export type Input = object } function save(value: N.Input) {}",
    0,
  ],
  [
    "qualified generic call scope",
    "type T = object; namespace N { type T = string; export type Input<X> = X } function save(value: N.Input<T>) {}",
    1,
  ],
  [
    "qualified generic default scope",
    "type T = string; namespace N { type T = object; export type Input<X = T> = X } function save(value: N.Input) {}",
    1,
  ],
  ["qualified unknown alias", "namespace N { export type Raw = unknown } type Copy = N.Raw", 2],
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
