import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.js";
import {
  noCrossRealmBuiltinInstanceof,
  noCrossRealmWebInstanceof,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.js";
import { getDiagnosticDocuments, getRuleDocuments } from "../../../docs/rules/source.js";

const project = createProjectFixture({ framework: "vite", files: { "tsconfig.json": "{}" } });
afterAll(() => project.dispose());

async function run(source: string, rule = noCrossRealmBuiltinInstanceof) {
  const result = await project.run({ rule, files: { "src/index.ts": source } });
  return result.diagnostics;
}

const count = async (source: string) => (await run(source)).length;

test("is a Strict-only rule with generated documentation", () => {
  expect(typescriptRulePack.presets.strict).toContain(noCrossRealmBuiltinInstanceof.meta.id);
  expect(typescriptRulePack.presets.recommended).not.toContain(
    noCrossRealmBuiltinInstanceof.meta.id,
  );
  expect(
    getRuleDocuments().find((rule) => rule.id === noCrossRealmBuiltinInstanceof.meta.id)?.examples
      .length,
  ).toBeGreaterThan(0);
  expect(getDiagnosticDocuments().find((diagnostic) => diagnostic.code === "TS0016")?.ruleId).toBe(
    noCrossRealmBuiltinInstanceof.meta.id,
  );
});

test.each([
  "Error",
  "TypeError",
  "AggregateError",
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "Promise",
  "Array",
  "Function",
  "Object",
])("reports %s under TS0016 and not TS0013", async (name) => {
  const source = `export const f = (value: unknown) => value instanceof ${name}`;
  expect(await run(source)).toMatchObject([{ code: "TS0016", confidence: "heuristic-low" }]);
  expect(await run(source, noCrossRealmWebInstanceof)).toHaveLength(0);
});

test.each(["Response", "Blob", "URL", "Uint8Array", "ArrayBuffer", "DOMException"])(
  "leaves the web platform class %s to TS0013",
  async (name) => {
    expect(await count(`export const f = (value: unknown) => value instanceof ${name}`)).toBe(0);
  },
);

test.each([
  ["any parameter", "export const f = (value: any) => value instanceof Date"],
  [
    "Vercel date from an unknown parameter (vitehub workflow vercel.ts before ed31f8fe96)",
    "export function toDate(value: unknown) { return value instanceof Date ? value : new Date(String(value)) }",
  ],
  [
    "Error message read with a literal fallback (vitehub source server.ts:65)",
    "export const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Invalid request.'",
  ],
  [
    "Error code read (vitehub blob, fixed in 123883116d)",
    "export const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'",
  ],
  [
    "Function (vitehub console, fixed in f192a0b09e)",
    "export function f(authorize: unknown) { if (!(authorize instanceof Function)) throw new TypeError('function') }",
  ],
  [
    "async validator from a callback",
    "export async function f(validate: () => unknown) { return validate() instanceof Promise }",
  ],
  [
    "exported error normalizer (vitehub sandbox errors.ts)",
    "export function toSandboxError(error: unknown) { return error instanceof Error ? error : new Error('Sandbox failed') }",
  ],
  [
    "overwritten Error.isError alternative",
    "Error.isError = () => false; export const f = (value: unknown) => value instanceof Error || Error.isError(value)",
  ],
  [
    "module-private error normalizer called with errors from an external callback",
    "function toError(error: unknown) { return error instanceof Error ? error : new Error('failed') } export function run(work: () => void) { try { work() } catch (error) { throw toError(error) } }",
  ],
])("reports %s", async (_name, source) => {
  expect(await count(source)).toBe(1);
});

test.each([
  [
    "Error message with a String() fallback that keeps the text",
    "export const message = (error: unknown) => error instanceof Error ? error.message : String(error)",
  ],
  ["catch parameter", "try { run() } catch (error) { if (error instanceof Error) throw error }"],
  ["local value", "const value = new Date(); export const ok = value instanceof Date"],
  ["typed parameter", "export const f = (value: Date | string) => value instanceof Date"],
  [
    "Array.isArray alternative",
    "export const f = (value: unknown) => Array.isArray(value) || value instanceof Array",
  ],
  [
    "Error.isError alternative",
    "export const f = (value: unknown) => value instanceof Error || Error.isError(value)",
  ],
])("does not report %s", async (_name, source) => {
  expect(await count(source)).toBe(0);
});

test.each([
  [
    "Map",
    "Replace instanceof Map with a guard helper, isMap(value): value is Map, that returns Object.prototype.toString.call(value) === '[object Map]'.",
  ],
  [
    "Error",
    "Replace instanceof Error with a guard helper, isError(value): value is Error, that returns Error.isError(value) where the runtime has it, or Object.prototype.toString.call(value) === '[object Error]'.",
  ],
  [
    "TypeError",
    "Replace instanceof TypeError with a guard helper, isTypeError(value): value is TypeError, that checks isError(value) and value.name === 'TypeError'.",
  ],
  [
    "Array",
    "Replace instanceof Array with Array.isArray(value), which is true for arrays from any realm.",
  ],
  [
    "Function",
    "Replace instanceof Function with typeof value === 'function', which is true for functions from any realm.",
  ],
])("suggests a realm-safe %s check that keeps the original meaning", async (name, suggestion) => {
  const [diagnostic] = await run(`export const is = (value: unknown) => value instanceof ${name}`);
  expect(diagnostic!.suggestion).toBe(suggestion);
});

test.each([
  `if (Object.prototype.toString.call(value) !== '[object Date]') return false; return value instanceof Date`,
  `console.log(Object.prototype.toString.call(value) === '[object Date]'); return value instanceof Date`,
  `return Object.prototype.toString.call(value) === '[object Date]' && value instanceof Date`,
  `if (Object.prototype.toString.call(value) === '[object Date]') return false; return value instanceof Date`,
  `return value instanceof Date || Object.prototype.toString.call(value) !== '[object Date]'`,
  `return value instanceof Error ? value.stack : String(value)`,
  `return value instanceof Error ? value.cause : String(value)`,
  `return value instanceof Error ? process(value) : String(value)`,
])("reports identity checks without a usable fallback: %s", async (body) => {
  expect(await count(`function f(value: unknown) { ${body} }`)).toBe(1);
});
