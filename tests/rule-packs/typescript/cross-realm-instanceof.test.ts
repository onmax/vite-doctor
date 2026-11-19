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
  ["any parameter", "export const f = (value: any) => value instanceof URL"],
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
    "export const f = (value: unknown | undefined) => value instanceof URL",
  ],
  [
    "const alias of an unknown parameter",
    "function f(value: unknown) { const alias = value; return alias instanceof URL }",
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
    "function f(value: unknown) { return value instanceof URL || isReady(value) }",
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
    "guard two statements away",
    "function f(value: unknown) { if (value instanceof Response) return value; log(); if (isResponseLike(value)) return value }",
  ],
])("reports %s", async (_name, source) => {
  expect(await count(source)).toBe(1);
});

test.each([
  ["typed parameter", "function f(value: URL) { return value instanceof URL }"],
  [
    "union parameter",
    "function f(value: Request | { url: string }) { return value instanceof Request }",
  ],
  ["catch parameter", "try { run() } catch (error) { if (error instanceof Response) throw error }"],
  [
    "DOMException message with a String() fallback that keeps the text",
    "export const message = (error: unknown) => error instanceof DOMException ? error.message : String(error)",
  ],
  [
    "DOMException in a catch parameter",
    "try { run() } catch (error) { console.log(error instanceof DOMException ? error.message : error) }",
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
    "export const f = (values: Map<string, unknown>) => values.get('at') instanceof Blob",
  ],
  [
    "Node util.types guard (realm-safe)",
    "import { types } from 'node:util'; export const f = (value: unknown) => value instanceof Uint8Array || types.isUint8Array(value)",
  ],
  ...["* as util", "util", "{ default as util }"].map((specifier) => [
    `Node util.types guard via ${specifier}`,
    `import ${specifier} from 'node:util'; export const f = (value: unknown) => value instanceof Uint8Array || util.types.isUint8Array(value)`,
  ]),
  [
    "same-file brand helper in a disjunct",
    "function hasByteBrand(input: unknown) { return Object.prototype.toString.call(input) === '[object Uint8Array]' } export const f = (value: unknown) => value instanceof Uint8Array || hasByteBrand(value)",
  ],
  [
    "same-file brand helper after a fast path",
    "const hasByteBrand = (input: unknown) => Object.prototype.toString.call(input) === '[object Uint8Array]'; export function f(value: unknown): value is Uint8Array { if (value instanceof Uint8Array) return true; return hasByteBrand(value) }",
  ],
  [
    "fast path in a brand-checking guard (vitehub runtime response.ts:124)",
    "export function isResponse(value: unknown): value is Response { if (value instanceof Response) return true; if (typeof value !== 'object' || value === null) return false; return Object.prototype.toString.call(value) === '[object Response]' }",
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
    "function f(value: unknown) { value = normalize(value); return value instanceof URL }",
  ],
  ["local value", "const value = new URL('https://x'); export const ok = value instanceof URL"],
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
  [
    "fast path in a type guard that falls back to a brand check in a try block",
    "export function isResponse(value: unknown): value is Response { if (value instanceof Response) return true; if (typeof value !== 'object' || value === null) return false; try { return Object.prototype.toString.call(value) === '[object Response]' } catch { return false } }",
  ],
  [
    "fast path in a type guard that falls back to a view check",
    "export function isBytes(value: unknown): value is ArrayBufferView { if (value instanceof Uint8Array) return true; return ArrayBuffer.isView(value) }",
  ],
  [
    "view guard in the same || chain (vitehub internal http-request.ts:268)",
    "export function f(body: unknown) { if (tag(body) === '[object String]' || body instanceof Uint8Array || isArrayBuffer(body) || ArrayBuffer.isView(body)) return body }",
  ],
])("does not report %s", async (_name, source) => {
  expect(await count(source)).toBe(0);
});

test.each([
  [
    "type guard whose fallback accepts a different type",
    "export function isBytes(value: unknown): value is Uint8Array | string { if (value instanceof Uint8Array) return true; return typeof value === 'string' }",
  ],
  [
    "local fallback that also relies on constructor identity",
    "const isUint8Array = (value: any) => value.constructor === Uint8Array; export function f(value: unknown, ready: boolean) { return ready || value instanceof Uint8Array || isUint8Array(value) }",
  ],
  [
    "similarly named util import from a different module",
    "import * as util from './util'; export const f = (value: unknown) => value instanceof Uint8Array || util.types.isUint8Array(value)",
  ],
  [
    "Node util guard applied to a different argument",
    "import { types } from 'node:util'; export const f = (value: unknown, other: unknown) => value instanceof Uint8Array || types.isUint8Array(other, value)",
  ],
  [
    "same-file helper with a negated brand check",
    "const hasByteBrand = (input: unknown) => Object.prototype.toString.call(input) !== '[object Uint8Array]'; export const f = (value: unknown) => value instanceof Uint8Array || hasByteBrand(value)",
  ],
  [
    "same-file helper with a shadowed Object",
    "const Object = { prototype: { toString: () => '[object String]' } }; const hasByteBrand = (input: unknown) => Object.prototype.toString.call(input) === '[object Uint8Array]'; export const f = (value: unknown) => value instanceof Uint8Array || hasByteBrand(value)",
  ],
  [
    "guard branch that rejects foreign values",
    "const hasByteBrand = (input: unknown) => Object.prototype.toString.call(input) === '[object Uint8Array]'; export function f(value: unknown): boolean { if (value instanceof Uint8Array) return true; if (hasByteBrand(value)) return false; return false }",
  ],
  [
    "same-file helper whose later parameter default changes the input",
    "function hasByteBrand(input: unknown, unused = (input = null)) { return Object.prototype.toString.call(input) === '[object Uint8Array]' } export const f = (value: unknown) => value instanceof Uint8Array || hasByteBrand(value)",
  ],
  [
    "shadowed ArrayBuffer.isView",
    "export function f(value: unknown, ArrayBuffer: { isView(value: unknown): boolean }) { return value instanceof Uint8Array || ArrayBuffer.isView(value) }",
  ],
  [
    "fallback brand check on a different subject",
    "export function f(value: unknown, other: unknown): value is URL { if (value instanceof URL) return true; return Object.prototype.toString.call(other) === '[object URL]' }",
  ],
  ...["", "undefined", "void 0"].map((argument) => [
    `potentially foreign default with argument '${argument}'`,
    `import { runInNewContext } from 'node:vm'; function isBytes(value: unknown = runInNewContext('new Uint8Array(1)')) { return value instanceof Uint8Array } export const ok = isBytes(${argument})`,
  ]),
  [
    "value from an injected constructor",
    "function isResponse(value: unknown) { return value instanceof Response } export function run(FetchResponse: typeof Response) { return isResponse(new FetchResponse('ok')) }",
  ],
  ...[
    "export function isResponse(value: unknown) { return value instanceof Response }",
    "export const isResponse = (value: unknown) => value instanceof Response",
  ].map((declaration) => [
    `namespace member: ${declaration}`,
    `export namespace adapter { ${declaration}; export const ok = isResponse(new Response('ok')) }`,
  ]),
  [
    "named function expression that recurses with a foreign value",
    "import { runInNewContext } from 'node:vm'; const check = function inner(value: unknown, retry: boolean): boolean { if (retry) return inner(runInNewContext('new Uint8Array(1)'), false); return value instanceof Uint8Array }; export const ok = check(new Uint8Array(1), true)",
  ],
  [
    "DOMException from an unknown source with the same message as a local error",
    "export const local = new DOMException('The operation was aborted.'); export const isAbort = (value: unknown) => value instanceof DOMException && value.message === 'The operation was aborted.'",
  ],
  [
    "type guard whose only fallback is false",
    "export function isResponse(value: unknown): value is Response { if (value instanceof Response) return true; return false }",
  ],
  [
    "fast path in a function that is not a type guard",
    "export function hasBody(value: unknown): boolean { if (value instanceof Response) return true; return typeof value === 'string' }",
  ],
  [
    "type guard for another parameter",
    "export function isPair(value: unknown, other: unknown): other is Response { if (value instanceof Response) return true; return isResponseLike(other) }",
  ],
  [
    "guard joined with && in the chain",
    "export function f(body: unknown, ready: boolean) { return body instanceof Uint8Array || (ready && ArrayBuffer.isView(body)) }",
  ],
  [
    "message created by another class",
    "const failure = new Error('[app] cleanup timed out.'); export const timedOut = (error: unknown) => error instanceof DOMException && error.message === '[app] cleanup timed out.'",
  ],
  [
    "message compared with || instead of &&",
    "const failure = new DOMException('[app] timed out.'); export const timedOut = (error: unknown) => error instanceof DOMException || error === '[app] timed out.'",
  ],
])("still reports %s", async (_name, source) => {
  expect(await count(source)).toBe(1);
});

test.each([
  [
    "module-private helper called with an unknown parameter",
    "function isBlob(value: unknown) { return value instanceof Blob } export const f = (input: unknown) => isBlob(input)",
  ],
  [
    "module-private helper called with a callback result",
    "function isResponse(value: unknown) { return value instanceof Response } export async function f(handler: () => unknown) { return isResponse(await handler()) }",
  ],
  [
    "module-private helper passed as a callback",
    "function isBlob(value: unknown) { return value instanceof Blob } export const f = (values: unknown[]) => values.filter(isBlob)",
  ],
  [
    "exported helper called with local values",
    "export function isURL(value: unknown) { return value instanceof URL } isURL(new URL('https://x'))",
  ],
  [
    "module-private helper called with a member of a typed value (vitehub workflow vercel.ts before ed31f8fe96)",
    "function normalize(value: unknown) { if (!(value instanceof URL)) throw new Error('url'); return value } export const f = (run: { url: URL }) => normalize(run.url)",
  ],
  [
    "module-private helper called with a typed parameter",
    "function bytes(value: unknown) { return value instanceof Uint8Array ? value : Uint8Array.from(value as number[]) } export const f = (value: Uint8Array | number[]) => bytes(value)",
  ],
  [
    "module-private helper called through another module-private helper with an unknown value",
    "function isBlob(value: unknown) { return value instanceof Blob } function size(value: unknown) { return isBlob(value) ? 1 : 0 } export const f = (input: unknown) => size(input)",
  ],
])("follows the caller of a %s", async (_name, source) => {
  expect(await count(source)).toBe(1);
});

test.each([
  [
    "module-private helper only called with local values",
    "function toBlob(value: unknown) { return value instanceof Blob ? value : new Blob([String(value)]) } export const blob = toBlob('text')",
  ],
  [
    "module-private helper with a local default",
    "function isAbort(error: unknown = new DOMException('aborted')) { return error instanceof DOMException } export const ok = isAbort(undefined) && isAbort()",
  ],
  [
    "module-private helper with an unused default",
    "function isBytes(value: unknown = elsewhere()) { return value instanceof Uint8Array } export const ok = isBytes(new Uint8Array(1))",
  ],
  [
    "module-private arrow helper",
    "const isURL = (value: unknown) => value instanceof URL; export const ok = isURL(new URL('https://x'))",
  ],
  [
    "module-private helper that calls itself with its own local values",
    "function size(value: unknown): number { return value instanceof Blob ? value.size : size(new Blob([])) } export const n = size('x')",
  ],
  [
    "module-private helper called through another module-private helper with local values",
    "function isBlob(value: unknown) { return value instanceof Blob } function size(value: unknown) { return isBlob(value) ? 1 : 0 } export const n = size(new Blob([]))",
  ],
])("does not report a %s", async (_name, source) => {
  expect(await count(source)).toBe(0);
});

test("reports a remediation that names a guard helper", async () => {
  const result = await project.run({
    rule: noCrossRealmWebInstanceof,
    files: { "src/url.ts": "export const isURL = (value: unknown) => value instanceof URL" },
  });
  expect(result.diagnostics[0]).toMatchObject({ code: "TS0013", severity: "warn" });
  expect(result.diagnostics[0]!.suggestion).toContain("[object URL]");
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
    "Uint8Array",
    "Replace instanceof Uint8Array with a guard helper, isUint8Array(value): value is Uint8Array, that returns ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'.",
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
  `return value instanceof DOMException || Object.prototype.toString.call(value) === '[object Error]'`,
  `return value instanceof DOMException || isError(value)`,
  `if (Object.prototype.toString.call(value) !== '[object URL]') return false; return value instanceof URL`,
  `return value instanceof URL || Object.prototype.toString.call(value) !== '[object URL]'`,
  `return value instanceof DOMException ? value.stack : String(value)`,
])("reports identity checks without a usable fallback: %s", async (body) => {
  expect(await count(`function f(value: unknown) { ${body} }`)).toBe(1);
});

test.each([
  `return value instanceof Blob || Object.prototype.toString.call(value) === '[object Blob]'`,
  `return value instanceof Blob || hasBlobBrand(value)`,
  `if (value instanceof Blob) return true; return Object.prototype.toString.call(value) === '[object Blob]'`,
  `if (value instanceof Blob) return true; return hasBlobBrand(value)`,
])("reports a Blob check when its fallback requires a tag: %s", async (body) => {
  expect(
    await count(`
      const hasBlobBrand = (input: unknown) => Object.prototype.toString.call(input) === '[object Blob]'
      export function f(value: unknown) { ${body} }
    `),
  ).toBe(1);
});

test.each(["File", "Headers", "FormData", "DOMException"])(
  "reports a %s check when its fallback requires a tag",
  async (name) => {
    expect(
      await count(
        `export function f(value: unknown) { return value instanceof ${name} || Object.prototype.toString.call(value) === '[object ${name}]' }`,
      ),
    ).toBe(1);
  },
);

test.each([
  ["Blob", "arrayBuffer(), size and type"],
  ["FormData", "get() or entries()"],
  ["DOMException", "name and message"],
])("suggests capability checks, not a %s class predicate", async (name, members) => {
  const result = await project.run({
    rule: noCrossRealmWebInstanceof,
    files: { "src/dom.ts": `export const f = (value: unknown) => value instanceof ${name}` },
  });
  const suggestion = result.diagnostics[0]!.suggestion;
  expect(suggestion).toContain(members);
  expect(suggestion).toContain("narrow only to the members you check");
  expect(suggestion).toContain("validate or normalize the value at the integration boundary");
  expect(suggestion).not.toContain(`value is ${name}`);
});
