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
])("reports %s", async (_name, source) => {
  expect(await count(source)).toBe(1);
});

test.each([
  ["typed parameter", "function f(value: Date) { return value instanceof Date }"],
  [
    "union parameter",
    "function f(value: Request | { url: string }) { return value instanceof Request }",
  ],
  [
    "Error is left out",
    "function f(error: unknown) { return error instanceof Error ? error.message : String(error) }",
  ],
  ["catch parameter", "try { run() } catch (error) { if (error instanceof Response) throw error }"],
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
    "imported function result",
    "import { load } from './load'; export const ok = load() instanceof Response",
  ],
  ["non-web class", "function f(value: unknown) { return value instanceof Map }"],
  [
    "import() method that does not load modules",
    "async function f(plugin: { import(id: string): Promise<any> }) { const data = await plugin.import('x'); return data.body instanceof Blob }",
  ],
  [
    "duck-typed alternative (vitehub agent chat-approvals.ts:412)",
    "function f(result: unknown) { if (result instanceof Response || isResponseLike(result)) return result }",
  ],
])("does not report %s", async (_name, source) => {
  expect(await count(source)).toBe(0);
});

test("reports a remediation that names a brand or duck-type check", async () => {
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
    "Replace instanceof ArrayBuffer with Object.prototype.toString.call(value) === '[object ArrayBuffer]'.",
  ],
  ["URL", "Replace instanceof URL with Object.prototype.toString.call(value) === '[object URL]'."],
])("suggests a %s brand check that keeps the original meaning", async (name, suggestion) => {
  const result = await project.run({
    rule: noCrossRealmWebInstanceof,
    files: { "src/brand.ts": `export const is = (value: unknown) => value instanceof ${name}` },
  });
  expect(result.diagnostics[0]!.suggestion).toBe(suggestion);
});
