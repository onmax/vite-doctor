import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.js";
import {
  noCrossRealmWebInstanceof,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.js";
import { getDiagnosticDocuments, getRuleDocuments } from "../../../docs/rules/source.js";

const project = createProjectFixture({ framework: "vite", files: { "tsconfig.json": "{}" } });
afterAll(() => project.dispose());

async function count(source: string) {
  const result = await project.run({
    rule: noCrossRealmWebInstanceof,
    files: { "src/index.ts": source },
  });
  return result.diagnostics.length;
}

test("is a Strict-only rule with generated documentation", () => {
  expect(typescriptRulePack.presets.strict).toContain(noCrossRealmWebInstanceof.meta.id);
  expect(typescriptRulePack.presets.recommended).not.toContain(noCrossRealmWebInstanceof.meta.id);
  expect(
    getRuleDocuments().find((rule) => rule.id === noCrossRealmWebInstanceof.meta.id)?.examples
      .length,
  ).toBeGreaterThan(0);
  expect(getDiagnosticDocuments().find((diagnostic) => diagnostic.code === "TS0013")?.ruleId).toBe(
    noCrossRealmWebInstanceof.meta.id,
  );
});

test.each([
  [
    "unknown parameter (vitehub runtime/src/response.ts)",
    "export function toResponse(value: unknown): Response { if (value instanceof Response) return value; return new Response(String(value)) }",
  ],
  ["any parameter", "export const f = (value: any) => value instanceof Date"],
  [
    "awaited callback result (vitehub 451425205)",
    "async function run(authorize: (c: unknown) => Promise<unknown>, context: unknown) { const result = await authorize(context); if (result instanceof Response) return result }",
  ],
  [
    "callback on an options parameter",
    "async function run(options: { handler(): unknown }) { return (await options.handler()) instanceof Response }",
  ],
  [
    "module from import()",
    "async function load(id: string) { const mod = await import(id); return mod.default instanceof Response }",
  ],
  [
    "module from ssrLoadModule",
    "async function load(server: { ssrLoadModule(id: string): Promise<any> }) { return (await server.ssrLoadModule('/x')).handler instanceof Request }",
  ],
  [
    "module from a Vite ModuleRunner",
    "async function load(runner: { import(id: string): Promise<any> }) { const mod = await runner.import('/x'); return mod.default instanceof Response }",
  ],
  [
    "const alias of a loaded module export",
    "async function load(server: { ssrLoadModule(id: string): Promise<any> }) { const value = (await server.ssrLoadModule('/x')).handler; return value instanceof Response }",
  ],
  [
    "destructured module export",
    "async function load(id: string) { const { handler } = await import(id); return handler instanceof Request }",
  ],
  [
    "parameter typed unknown | undefined",
    "export const f = (value: unknown | undefined) => value instanceof Date",
  ],
  [
    "const alias of an unknown parameter",
    "function f(value: unknown) { const alias = value; return alias instanceof Date }",
  ],
  [
    "guard for a different type",
    "function f(value: unknown) { return value instanceof ArrayBuffer || isArrayBufferView(value) }",
  ],
  [
    "awaited export of a loaded module",
    "async function load(id: string) { const mod = await import(id); return (await mod.default) instanceof Response }",
  ],
  [
    "negative guard",
    "function f(value: unknown) { return value instanceof Response || isNotResponse(value) }",
  ],
  [
    "guard that does not check the class",
    "function f(value: unknown) { return value instanceof Date || isReady(value) }",
  ],
  [
    "negated check",
    "function f(value: unknown) { if (!(value instanceof Blob)) throw new Error('blob') }",
  ],
  [
    "check followed by an unrelated statement (vitehub auth event-plugin.ts:240)",
    "async function f(authorize: () => Promise<unknown>) { const authorization = await authorize(); if (authorization instanceof Response) return authorization; if (authorization !== true) throw new Error('forbidden') }",
  ],
  [
    "guard on another value in the next statement",
    "function f(value: unknown, other: unknown) { if (value instanceof Response) return value; if (isResponseLike(other)) return other }",
  ],
  [
    "byte array check (vitehub kv inspect-value.ts, fixed in 58f09e24ae)",
    "export function kvValueType(value: unknown): string { if (value instanceof Uint8Array) return 'bytes'; return typeof value }",
  ],
  ["DataView", "export const f = (value: unknown) => value instanceof DataView"],
  ["other typed array", "export const f = (value: unknown) => value instanceof Float64Array"],
  ["SharedArrayBuffer", "export const f = (value: unknown) => value instanceof SharedArrayBuffer"],
  [
    "Error message read with a literal fallback (vitehub source server.ts:65)",
    "export const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Invalid request.'",
  ],
  [
    "Error code read (vitehub blob, fixed in 123883116d)",
    "export const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'",
  ],
  ["Error subclass", "export const f = (error: unknown) => error instanceof AggregateError"],
  ["Map", "export const f = (value: unknown) => value instanceof Map"],
  ["Set", "export const f = (value: unknown) => value instanceof Set"],
  ["RegExp", "export const f = (value: unknown) => value instanceof RegExp"],
  ["Promise", "export const f = (value: unknown) => value instanceof Promise"],
  ["Array", "export const f = (value: unknown) => value instanceof Array"],
  [
    "Function (vitehub console, fixed in f192a0b09e)",
    "export function f(authorize: unknown) { if (!(authorize instanceof Function)) throw new TypeError('function') }",
  ],
  ["Object", "export const f = (value: any) => value instanceof Object"],
  [
    "guard two statements away",
    "function f(value: unknown) { if (value instanceof Response) return value; log(); if (isResponseLike(value)) return value }",
  ],
])("reports %s", async (_name, source) => {
  expect(await count(source)).toBe(1);
});

test.each([
  ["typed parameter", "function f(value: Date) { return value instanceof Date }"],
  [
    "union parameter",
    "function f(value: Request | { url: string }) { return value instanceof Request }",
  ],
  ["catch parameter", "try { run() } catch (error) { if (error instanceof Response) throw error }"],
  [
    "Error message with a String() fallback that keeps the text (vitehub browser errors.ts before 8142b1b78e)",
    "export const message = (error: unknown) => error instanceof Error ? error.message : String(error)",
  ],
  [
    "Error in a catch parameter",
    "try { run() } catch (error) { console.log(error instanceof Error ? error.message : error) }",
  ],
  [
    "local byte array",
    "const bytes = new Uint8Array(4); export const ok = bytes instanceof Uint8Array",
  ],
  [
    "typed byte array parameter",
    "export const f = (value: Uint8Array | string) => value instanceof Uint8Array",
  ],
  [
    "method on a typed Map",
    "export const f = (values: Map<string, unknown>) => values.get('at') instanceof Date",
  ],
  [
    "Node util.types guard (realm-safe)",
    "import { types } from 'node:util'; export const f = (value: unknown) => value instanceof Uint8Array || types.isUint8Array(value)",
  ],
  [
    "fast path in a brand-checking guard (vitehub runtime response.ts:124)",
    "export function isResponse(value: unknown): value is Response { if (value instanceof Response) return true; if (typeof value !== 'object' || value === null) return false; return Object.prototype.toString.call(value) === '[object Response]' }",
  ],
  [
    "Array.isArray alternative",
    "export const f = (value: unknown) => Array.isArray(value) || value instanceof Array",
  ],
  [
    "local class",
    "class Response {} function f(value: unknown) { return value instanceof Response }",
  ],
  [
    "imported class",
    "import { Response } from 'undici'; export function f(value: unknown) { return value instanceof Response }",
  ],
  [
    "reassigned parameter",
    "function f(value: unknown) { value = normalize(value); return value instanceof Date }",
  ],
  ["local value", "const value = new Date(); export const ok = value instanceof Date"],
  [
    "method on a typed web value",
    "function f(request: Request) { return request.clone() instanceof Request }",
  ],
  [
    "method on an optional typed web value",
    "function f(request: Request | undefined) { if (request) return request.clone() instanceof Request }",
  ],
  [
    "module namespace itself",
    "async function load(id: string) { const mod = await import(id); return mod instanceof Response }",
  ],
  [
    "imported function result",
    "import { load } from './load'; export const ok = load() instanceof Response",
  ],
  [
    "class outside the built-ins",
    "function f(value: unknown) { return value instanceof WorkspaceError }",
  ],
  [
    "import() method that does not load modules",
    "async function f(plugin: { import(id: string): Promise<any> }) { const data = await plugin.import('x'); return data.body instanceof Blob }",
  ],
  [
    "async-iterable alternative for streams (vitehub agent progress-summary.ts:361)",
    "function f(value: unknown) { return isAsyncIterable(value) || value instanceof ReadableStream }",
  ],
  [
    "duck-typed alternative (vitehub agent chat-approvals.ts:412)",
    "function f(result: unknown) { if (result instanceof Response || isResponseLike(result)) return result }",
  ],
  [
    "guard in an && sibling (vitehub internal http-request.ts:262)",
    "function f(body: unknown) { if (isBlobLike(body) && !(body instanceof Blob)) return normalizeForeignBlob(body) }",
  ],
  [
    "guard in the next statement (vitehub agent server/routes.ts:443)",
    "function f(value: unknown) { if (value instanceof Response && value.body) return value.body; if (isResponseLike(value)) return value.body; throw new Error('stream') }",
  ],
  [
    "guard in the previous statement",
    "function f(value: unknown) { if (isResponseLike(value)) return value; return value instanceof Response ? value : undefined }",
  ],
])("does not report %s", async (_name, source) => {
  expect(await count(source)).toBe(0);
});

test("reports a remediation that names a guard helper", async () => {
  const result = await project.run({
    rule: noCrossRealmWebInstanceof,
    files: { "src/date.ts": "export const isDate = (value: unknown) => value instanceof Date" },
  });
  expect(result.diagnostics[0]).toMatchObject({ code: "TS0013", severity: "warn" });
  expect(result.diagnostics[0]!.suggestion).toContain("[object Date]");
});

test.each([
  [
    "ArrayBuffer",
    "Replace instanceof ArrayBuffer with a guard helper, isArrayBuffer(value): value is ArrayBuffer, that returns Object.prototype.toString.call(value) === '[object ArrayBuffer]'.",
  ],
  [
    "URL",
    "Replace instanceof URL with a guard helper, isURL(value): value is URL, that returns Object.prototype.toString.call(value) === '[object URL]'.",
  ],
  [
    "Blob",
    "Replace instanceof Blob with a guard helper, isBlobLike(value): value is Blob, that checks the members you use, such as arrayBuffer(), size and type.",
  ],
  [
    "Uint8Array",
    "Replace instanceof Uint8Array with a guard helper, isUint8Array(value): value is Uint8Array, that returns ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'.",
  ],
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
])("suggests a %s guard helper that keeps the original meaning", async (name, suggestion) => {
  const result = await project.run({
    rule: noCrossRealmWebInstanceof,
    files: { "src/brand.ts": `export const is = (value: unknown) => value instanceof ${name}` },
  });
  expect(result.diagnostics[0]!.suggestion).toBe(suggestion);
});

test.each([
  `if (isResponseLike(value) && value instanceof Response) return value; throw new Error()`,
  `if (!(value instanceof Response) || isResponseLike(value)) throw new Error()`,
  `console.log(isResponseLike(value)); if (!(value instanceof Response)) throw new Error()`,
  `if (isResponseLike(value)) console.log(value); if (!(value instanceof Response)) throw new Error()`,
  `if (value instanceof Response) return value; if (ready) log(isResponseLike(value));`,
  `if (value instanceof Response) return value; return () => Object.prototype.toString.call(value) === '[object Response]'`,
  `if (value instanceof Response) return value; return { tag: Object.prototype.toString.call(value) }`,
  `if (value instanceof Response) return value; return Object.prototype.toString.call(value) === '[object Request]'`,
])("reports mandatory instanceof despite nearby guards: %s", async (body) => {
  expect(await count(`function f(value: unknown) { ${body} }`)).toBe(1);
});

test.each([
  `!(value instanceof Response || isResponseLike(value))`,
  `enabled && (value instanceof Response || isResponseLike(value))`,
  `(value instanceof Response || isResponseLike(value)) && enabled`,
])("accepts nested realm-safe alternatives: %s", async (condition) => {
  expect(await count(`function f(value: unknown, enabled: boolean) { return ${condition} }`)).toBe(
    0,
  );
});

test.each([
  ["Uint8Array", "a Uint8Array"],
  ["ArrayBuffer", "an ArrayBuffer"],
  ["URL", "a URL"],
])("names the %s class with its article", async (name, phrase) => {
  const result = await project.run({
    rule: noCrossRealmWebInstanceof,
    files: { "src/article.ts": `export const is = (value: unknown) => value instanceof ${name}` },
  });
  expect(result.diagnostics[0]!.message).toContain(`can hold ${phrase} created`);
});

test.each([
  `if (Object.prototype.toString.call(value) !== '[object Date]') return false; return value instanceof Date`,
  `console.log(Object.prototype.toString.call(value) === '[object Date]'); return value instanceof Date`,
  `return Object.prototype.toString.call(value) === '[object Date]' && value instanceof Date`,
  `return value instanceof DOMException || Object.prototype.toString.call(value) === '[object Error]'`,
  `return value instanceof DOMException || isError(value)`,
  `if (Object.prototype.toString.call(value) === '[object Date]') return false; return value instanceof Date`,
  `return value instanceof Date || Object.prototype.toString.call(value) !== '[object Date]'`,
  `return value instanceof Error ? value.stack : String(value)`,
  `return value instanceof Error ? value.cause : String(value)`,
  `return value instanceof Error ? process(value) : String(value)`,
])("reports identity checks without a usable fallback: %s", async (body) => {
  expect(await count(`function f(value: unknown) { ${body} }`)).toBe(1);
});

test("DOMException remediation uses its actual runtime brand", async () => {
  const result = await project.run({
    rule: noCrossRealmWebInstanceof,
    files: { "src/dom.ts": "export const f = (value: unknown) => value instanceof DOMException" },
  });
  const tag = Object.prototype.toString.call(new DOMException("aborted", "AbortError"));
  expect(tag).toBe("[object DOMException]");
  expect(result.diagnostics[0]!.suggestion).toContain(`=== '${tag}'`);
  expect(
    await count(
      `function f(value: unknown) { return value instanceof DOMException || Object.prototype.toString.call(value) === '${tag}' }`,
    ),
  ).toBe(0);
});
