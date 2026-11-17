import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.js";
import { noObjectParameters } from "../../../src/rule-packs/typescript/index.js";

const project = createProjectFixture({ framework: "vite", files: { "tsconfig.json": "{}" } });
afterAll(() => project.dispose());

async function lines(source: string) {
  const result = await project.run({ rule: noObjectParameters, files: { "src/index.ts": source } });
  return result.diagnostics.map((item) => item.range?.line);
}

test.each([
  [
    "Reflect and Object reflection (vitehub agent-layers.ts:435)",
    `export function copy(source: object, target: object): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor) Object.defineProperty(target, key, descriptor)
  }
}`,
  ],
  [
    "a WeakMap key (vitehub internal runtime/page-tools.ts:93)",
    `const accounts = new WeakMap<object, () => string>()
export function readAccount(app: object): string | undefined {
  return accounts.get(app)?.()
}
export function setAccount(app: object, read: () => string) {
  accounts.set(app, read)
}`,
  ],
  [
    "a WeakSet member",
    `const seen = new WeakSet<object>()
export function visit(value: object) { if (seen.has(value)) return; seen.add(value) }`,
  ],
  ["the right side of in", `export const hasId = (value: object) => 'id' in value`],
  ["Object.keys", `export const size = (value: object) => Object.keys(value).length`],
])("does not report object used only for identity or reflection: %s", async (_name, source) => {
  expect(await lines(source)).toEqual([]);
});

test.each([
  [
    "a value asserted to a concrete type later (vitehub runtime/src/host.ts:80)",
    `export function binding(name: string, event?: object) {
  const env = (event && bindingsOf(event)) ?? {}
  return env[name]
}
function bindingsOf(event: object) { return (event as { env?: Record<string, unknown> }).env }`,
    [1, 5],
  ],
  [
    "a value read as a record",
    `export function save(value: object) { return JSON.stringify(value) }`,
    [1],
  ],
  [
    "one identity use next to a property read",
    `const seen = new WeakSet<object>()
export function visit(value: object) { seen.add(value); return (value as { id: string }).id }`,
    [2],
  ],
  ["a declaration without a body", `export declare function save(value: object): void`, [1]],
])("reports %s", async (_name, source, expected) => {
  expect(await lines(source)).toEqual(expected);
});

test("custom collection-named methods do not prove identity use", async () => {
  expect(
    await lines(`const settings = { set(value: unknown) { return JSON.stringify(value) } }
export function configure(options: object) { return settings.set(options) }`),
  ).toEqual([2]);
});

test.each([
  `const cache = new Map<object, number>(); export const read = (value: object) => cache.get(value)`,
  `export function seen(value: object, cache: WeakSet<object>) { return cache.has(value) }`,
])("accepts evidenced collection receivers: %s", async (source) => {
  expect(await lines(source)).toEqual([]);
});
test.each([
  `declare const settings: { set(value: object): string }; export const save = (value: object) => settings.set(value)`,
  `class WeakMap { get(value: unknown) { return JSON.stringify(value) } }; const cache = new WeakMap(); export const save = (value: object) => cache.get(value)`,
])("rejects unresolved and shadowed collection receivers: %s", async (source) => {
  expect((await lines(source)).length).toBeGreaterThan(0);
});
