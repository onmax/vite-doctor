import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.js";
import {
  noInheritedKeyLookup,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.js";
import { getDiagnosticDocuments, getRuleDocuments } from "../../../docs/rules/source.js";

const project = createProjectFixture({ framework: "vite", files: { "tsconfig.json": "{}" } });
afterAll(() => project.dispose());

async function run(source: string, file = "src/index.ts") {
  const result = await project.run({ rule: noInheritedKeyLookup, files: { [file]: source } });
  return result.diagnostics;
}

test("is a Strict-only rule with generated documentation", () => {
  expect(typescriptRulePack.presets.strict).toContain(noInheritedKeyLookup.meta.id);
  expect(typescriptRulePack.presets.recommended).not.toContain(noInheritedKeyLookup.meta.id);
  expect(
    getRuleDocuments().find((rule) => rule.id === noInheritedKeyLookup.meta.id)?.examples.length,
  ).toBeGreaterThan(0);
  expect(
    getDiagnosticDocuments().find(
      (diagnostic) => diagnostic.ruleId === noInheritedKeyLookup.meta.id,
    )?.code,
  ).toMatch(/^TS\d{4}$/);
});

test.each([
  [
    "a membership test with a key from another record (vitehub 70631a0002)",
    "export function remove(environments: Record<string, unknown>, byEnvironment: Record<string, string[]>) { for (const [name] of Object.entries(byEnvironment)) { if (!(name in environments)) continue } }",
  ],
  [
    "a membership test with an option property as the key (vitehub c933a2918e)",
    "export function assertServeStore(serve: { store: string } | undefined, stores: Record<string, { driver: string }>) { if (!serve || serve.store in stores) return; throw new Error('missing') }",
  ],
  [
    "a lookup by a string parameter",
    "export function useDatabase(databases: Record<string, { url: string }>, name: string) { const entry = databases[name]; if (!entry) throw new Error(name); return entry }",
  ],
  [
    "a method called on the looked-up entry (vitehub kv redis-driver.ts)",
    "export function url(env: Record<string, string | undefined>, name: string) { return env[name]?.trim() }",
  ],
  [
    "a function member read off the looked-up entry",
    "export function call(handlers: Record<string, () => void>, name: string) { return handlers[name].call(undefined) }",
  ],
  [
    "an optional call on an inherited key",
    "export function run(options: { [name: string]: (() => void) | undefined }, name: string) { options[name]?.() }",
  ],
  [
    "a read checked as a function (vitehub agent ui/vue.ts)",
    "export function listener(props: Record<string, unknown>, name: string) { const value = props[name]; return typeof value === 'function' ? () => value() : undefined }",
  ],
  [
    "a lookup with a nullish default",
    "export function read(env: Record<string, string | undefined>, name: string) { return env[name] ?? 'fallback' }",
  ],
  [
    "an optional-chain lookup",
    "export function contentType(path: string, contentTypes: Record<string, string> | undefined) { return contentTypes?.[path] }",
  ],
  [
    "a readonly record",
    "export function read(values: Readonly<Record<string, string>>, key: string) { return values[key] }",
  ],
  [
    "a record typed with a local alias",
    "type Registry = Record<string, { run(): void }>\nexport function load(registry: Registry, name: string) { return registry[name] }",
  ],
  [
    "a record typed with a local index-signature interface",
    "interface Commands { [name: string]: { run(): void } }\nexport function find(commands: Commands, text: string) { const name = /^[a-z]+/.exec(text)?.[0]; if (name && commands[name]) return commands[name] }",
  ],
  [
    "a record property of a locally typed option (vitehub 65058871bb)",
    "interface EnvContext { env: Record<string, string | undefined> }\nexport function resolve(context: EnvContext, names: string[]) { for (const name of names) { const value = context.env[name]; if (value) return value } }",
  ],
  [
    "a record asserted from another type (vitehub ff579d6871)",
    "export function actions(definition: { api: unknown, apis: Record<string, string> }) { const selection = definition.api as Readonly<Record<string, readonly string[]>>; for (const [api] of Object.entries(definition.apis)) { const patterns = selection[api] } }",
  ],
  [
    "a membership test against a module object literal (vitehub 2afe71a48e)",
    "const presets = { cloudflare: 'kv', node: 'fs' }\nexport function isDriver(value: unknown) { return typeof value === 'string' && value in presets }",
  ],
  [
    "a membership test on a local table with a parameter's field (vitehub c2822c2697)",
    "export function traceName(event: { type: string }) { const names = { error: 'stream.error', finish: 'stream.finish' } as const; return event.type in names ? names[event.type as keyof typeof names] : undefined }",
  ],
  [
    "a membership test inside a replace callback (vitehub 86a3ae0a9c)",
    "export function routePath(route: string, values: Record<string, string>) { return route.replace(/:([^/]+)/g, (match, param: string) => param in values ? values[param]! : match) }",
  ],
  [
    "a membership test on a record returned by a local helper (vitehub 70631a0002)",
    "function clone(value: unknown): Record<string, unknown> { return { ...(value as object) } }\nexport function remove(env: unknown, byEnvironment: Record<string, string[]>) { const environments = clone(env); for (const [name] of Object.entries(byEnvironment)) { if (!(name in environments)) continue } }",
  ],
  [
    "a read compared with undefined",
    "export function check(value: Record<string, unknown>, name: string) { if (value[name] === undefined) throw new Error(name) }",
  ],
  [
    "a regex group that can match any word (vitehub e859b1e26e)",
    "export function find(commands: Record<string, () => void>, text: string) { const match = /^([a-z]+)/.exec(text); if (match && commands[match[1]!]) return match[1] }",
  ],
  [
    "a template key that can spell a prototype key",
    "export function read(values: Record<string, string>, prefix: string, name: string) { return values[`${prefix}${name}`] }",
  ],
  [
    "a lookup on a record parameter typed object",
    "export function has(value: object, key: string) { return key in value }",
  ],
])("reports %s", async (_name, source) => {
  expect(await run(source)).toHaveLength(1);
});

test("reports a membership test and the read it guards once", async () => {
  const diagnostics = await run(
    "export function read(values: Record<string, string>, key: string) { if (key in values) return values[key] }",
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.code).toMatch(/^TS\d{4}$/);
  expect(diagnostics[0]?.message).toContain("toString");
});

test.each([
  [
    "a literal key",
    "export function f(value: Record<string, unknown>) { return 'name' in value && value['name'] }",
  ],
  [
    "a key typed with a literal union",
    "export function f(values: Record<string, number>, key: 'a' | 'b') { return key in values ? values[key] : 0 }",
  ],
  [
    "a numeric key",
    "export function f(values: Record<number, string>, index: number) { return values[index] }",
  ],
  ["an array element", "export function f(items: string[], index: number) { return items[index] }"],
  [
    "a for-in key over the same record",
    "export function f(values: Record<string, number>) { let sum = 0; for (const key in values) sum += values[key]!; return sum }",
  ],
  [
    "an Object.entries key over the same record",
    "export function f(values: Record<string, number>) { for (const [key] of Object.entries(values)) console.log(values[key]) }",
  ],
  [
    "an Object.keys callback key over the same record",
    "export function f(values: Record<string, number>) { return Object.keys(values).map((key) => values[key]) }",
  ],
  [
    "a key iterated from a literal list",
    "export function f(values: Record<string, unknown>) { return (['get', 'set'] as const).some((key) => key in values) }",
  ],
  [
    "an Object.hasOwn guard in the same condition",
    "export function f(values: Record<string, string>, key: string) { return Object.hasOwn(values, key) ? values[key] : undefined }",
  ],
  [
    "an early return on a failed Object.hasOwn guard",
    "export function f(values: Record<string, string>, key: string) { if (!Object.hasOwn(values, key)) return; return values[key] }",
  ],
  [
    "a hasOwnProperty.call guard",
    "export function f(values: Record<string, string>, key: string) { return Object.prototype.hasOwnProperty.call(values, key) && values[key] }",
  ],
  [
    "an own-key check that only rejects inherited keys (vitehub 4433455a1d)",
    "export function f(input: Record<string, unknown>, keys: Set<string>) { return [...keys].find((key) => key in input && !Object.hasOwn(input, key)) }",
  ],
  [
    "a null-prototype record from Object.create(null)",
    "export function f(key: string) { const values: Record<string, string> = Object.create(null); return values[key] }",
  ],
  [
    "a null-prototype object literal",
    "const presets: Record<string, string> = { __proto__: null, node: 'fs' }\nexport function f(key: string) { return key in presets }",
  ],
  [
    "a write",
    "export function f(values: Record<string, string>, key: string) { values[key] = 'x'; delete values[key] }",
  ],
  [
    "a typed key into a module object literal",
    "const presets = { node: 'fs', deno: 'kv' }\nexport function f(kind: keyof typeof presets) { return presets[kind] }",
  ],
  [
    "a lookup checked against a primitive typeof",
    "export function f(values: Record<string, unknown>, key: string) { return typeof values[key] === 'string' }",
  ],
  [
    "a Map-typed value",
    "export function f(values: Map<string, string>, key: string) { return values.get(key) }",
  ],
  [
    "a key captured by a regex group of listed words",
    "const units: Record<string, number> = { s: 1000, m: 60000 }\nexport function parse(text: string) { const match = /^(\\d+)(s|m)$/i.exec(text); return match ? Number(match[1]) * units[match[2]!.toLowerCase()]! : 0 }",
  ],
  [
    "a replace callback group of listed words",
    "export function decode(text: string, entities: Record<string, string>) { return text.replace(/&(amp|lt|gt);/g, (_match, entity: string) => entities[entity] ?? ' ') }",
  ],
  [
    "a read compared with another record",
    "export function same(a: Record<string, string>, b: Record<string, string>) { const keys = Object.keys(a); return keys.every((key) => a[key] === b[key]) }",
  ],
  [
    "keys sorted from the same record",
    "export function stable(record: Record<string, unknown>) { return Object.keys(record).sort().map((key) => [key, record[key]]) }",
  ],
  [
    "an accumulator this function fills",
    "export function group(items: { key: string }[]) { const grouped: Record<string, string[]> = {}; for (const item of items) (grouped[item.key] ??= []).push(item.key); return grouped }",
  ],
  [
    "a lookup-table read with a default",
    "const statuses: Record<string, number> = { NOT_FOUND: 404 }\nexport function status(code: string) { return statuses[code] ?? 500 }",
  ],
  [
    "a property reader over an unknown value",
    "export function method(handle: unknown, name: string) { const fn = typeof handle === 'object' && handle !== null ? (handle as Record<string, unknown>)[name] : undefined; if (typeof fn !== 'function') throw new Error(name); return fn }",
  ],
  [
    "an imported constant key",
    "import { urlVariable } from './names'\nexport function url(env: Record<string, string | undefined>) { return env[urlVariable]?.trim() }",
  ],
  [
    "a symbol key",
    "const key = Symbol.for('vitehub.key')\nexport function read(scope: Record<PropertyKey, unknown>) { return scope[key] }",
  ],
  [
    "a template key with fixed text no prototype key has",
    "export function apiKey(env: Record<string, string | undefined>, name: string) { return env[`${name}_API_KEY`] }",
  ],
  [
    "a key found with an own-key check (vitehub connections policy.ts)",
    "export function rule(access: Record<string, string>, actor: string, inherited: string[]) { const match = [actor, ...inherited].find((candidate) => Object.hasOwn(access, candidate)); return match ? access[match] : undefined }",
  ],
  [
    "a key checked against a literal set",
    "const methods = new Set(['get', 'set'])\nexport function method(driver: Record<string, () => void>, prop: string) { if (!methods.has(prop)) return; return driver[prop] }",
  ],
  [
    "a key picked from the record's own keys",
    "export function pick(entries: Record<string, string>, subpath: string) { const pattern = Object.keys(entries).filter((key) => subpath.startsWith(key)).sort()[0]; return pattern ? entries[pattern] : undefined }",
  ],
  [
    "a read the author asserts is present",
    "export function command(commands: Record<string, () => void>, name: string) { return commands[name]! }",
  ],
  [
    "a read checked with a shape guard that rejects functions",
    "declare function isRecord(value: unknown): value is Record<string, unknown>\nexport function child(elements: Record<string, unknown>, id: string) { const element = elements[id]; if (!isRecord(element)) return; return element }",
  ],
  [
    "a membership test on a local table with a key from local data",
    "export function count(rows: { status: string }[]) { for (const row of rows) { const counts = { ok: 0, failed: 0 }; const status = row.status; if (status in counts) counts[status as keyof typeof counts]++ } }",
  ],
  [
    "an asserted key into a lookup table",
    "const units = { kb: 1024, mb: 1048576 }\nexport function size(unit: string) { return units[unit as keyof typeof units] }",
  ],
  [
    "keys from a const alias of the same record",
    "export function copy(value: object) { const source = value as Record<string, unknown>; const output: Record<string, unknown> = {}; for (const key of Object.keys(value)) output[key] = source[key]; return output }",
  ],
  [
    "a read narrowed by a shape check of the same lookup",
    "export function append(input: Record<string, unknown>, key: string, items: string[]) { input[key] = [...(Array.isArray(input[key]) ? input[key] : []), ...items] }",
  ],
  [
    "a key validated with includes",
    "export function dialect(dialects: Record<string, string>, names: string[], name: string) { if (!names.includes(name)) throw new Error(name); return dialects[name] }",
  ],
  [
    "a read flowing into a typeof check through a conditional",
    "export function header(headers: Record<string, unknown> | undefined, name: string) { const get = headers?.get; const value: unknown = typeof get === 'function' ? get.call(headers, name) : headers?.[name]; if (typeof value === 'string') return value }",
  ],
  [
    "a key destructured from a literal list of objects",
    "const capabilities = [{ name: 'browser' }, { name: 'gmail' }]\nexport function render(imports: Record<string, string>) { return capabilities.flatMap(({ name }) => imports[name] ? [imports[name]] : []) }",
  ],
  [
    "a module namespace",
    "export async function load(loader: { import(id: string): Promise<unknown> }, id: string, name: string) { const mod = await loader.import(id) as Record<string, unknown>; return mod[name] }",
  ],
  [
    "a key from a literal list of tuples",
    "const variables: ReadonlyArray<readonly [string, string]> = [['GITHUB_SHA', 'GITHUB_REF_NAME'], ['CF_PAGES_COMMIT_SHA', 'CF_PAGES_BRANCH']]\nexport function revision(env: Record<string, string | undefined>) { for (const [commit, branch] of variables) { if (env[commit]) return [env[commit], env[branch]] } }",
  ],
  [
    "a read checked with String(value) === value",
    "export function title(data: Record<string, unknown>, field: string, id: string) { const title = data[field]; return String(title) === title && title.trim() ? title : id }",
  ],
  [
    "a read compared through the same normalizer",
    "declare function stableJson(value: unknown): string\nexport function changed(current: Record<string, unknown>, next: Record<string, unknown>) { return Object.keys(next).filter((key) => stableJson(current[key]) !== stableJson(next[key])) }",
  ],
  [
    "keys from the entries of an object literal",
    "const names = { apiKey: 'API_KEY', from: 'FROM' }\nexport function settings(namespace: Record<string, unknown>) { for (const [key] of Object.entries(names)) console.log(namespace[key]) }",
  ],
  [
    "a read spread into an object literal",
    "export function config(projections: Record<string, { region?: string }>, name: string) { return { ...projections[name], name } }",
  ],
  [
    "a read passed to a local helper that checks its type",
    "function trimmed(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }\nexport function read(env: Record<string, string | undefined>, names: string[]) { for (const name of names) { const value = trimmed(env[name]); if (value) return value } }",
  ],
  [
    "a property read off the looked-up entry",
    "export function database(databases: Record<string, { db: unknown }>, name: string) { return databases[name]?.db }",
  ],
  [
    "a read checked with Object.prototype.toString",
    "export function text(metadata: Record<string, unknown> | undefined, key: string) { const value = metadata?.[key]; return Object.prototype.toString.call(value) === '[object String]' ? String(value) : undefined }",
  ],
  [
    "a record of unknown shape",
    "export function f(values: SomeImportedType, key: string) { return values[key] }",
  ],
])("ignores %s", async (_name, source) => {
  expect(await run(source)).toEqual([]);
});

test("ignores JavaScript files", async () => {
  expect(
    await run("export function f(values, key) { return key in values }", "src/index.js"),
  ).toEqual([]);
});
