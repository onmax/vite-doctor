import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.js";
import {
  noCrossRealmPrototypeIdentity,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.js";
import { getDiagnosticDocuments, getRuleDocuments } from "../../../docs/rules/source.js";

const project = createProjectFixture({ framework: "vite", files: { "tsconfig.json": "{}" } });
afterAll(() => project.dispose());

async function run(source: string) {
  const result = await project.run({
    rule: noCrossRealmPrototypeIdentity,
    files: { "src/index.ts": source },
  });
  return result.diagnostics;
}

test("is a Strict-only rule with generated documentation", () => {
  expect(typescriptRulePack.presets.strict).toContain(noCrossRealmPrototypeIdentity.meta.id);
  expect(typescriptRulePack.presets.recommended).not.toContain(
    noCrossRealmPrototypeIdentity.meta.id,
  );
  expect(
    getRuleDocuments().find((rule) => rule.id === noCrossRealmPrototypeIdentity.meta.id)?.examples
      .length,
  ).toBeGreaterThan(0);
  expect(
    getDiagnosticDocuments().find(
      (diagnostic) => diagnostic.ruleId === noCrossRealmPrototypeIdentity.meta.id,
    )?.code,
  ).toMatch(/^TS\d{4}$/);
});

test.each([
  [
    "getPrototypeOf compared with Object.prototype",
    "export const isPlain = (value: unknown) => Object.getPrototypeOf(value) === Object.prototype",
  ],
  [
    "prototype const compared with Object.prototype (vitehub runtime-type.ts)",
    "export function isPlain(value: any) { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null }",
  ],
  [
    "Array.prototype (vitehub internal provider-output-config.ts)",
    "export function isArray(value: unknown) { return Object.getPrototypeOf(value) !== Array.prototype }",
  ],
  [
    "Reflect.getPrototypeOf and Error.prototype (vitehub agent-output.ts)",
    "export const isBaseError = (value: unknown) => Reflect.getPrototypeOf(value as object) === Error.prototype",
  ],
  [
    "constructor compared with Object",
    "export const isPlain = (value: any) => value.constructor === Object",
  ],
  [
    "operands in either order",
    "export const isPlain = (value: unknown) => Object.prototype === Object.getPrototypeOf(value)",
  ],
  [
    "prototype of a prototype (vitehub realtime request.ts)",
    "export function isInstance(value: unknown) { const prototype = Object.getPrototypeOf(value); return Object.getPrototypeOf(prototype) !== Object.prototype }",
  ],
  [
    "callback result",
    "export async function run(load: () => Promise<unknown>) { const result = await load(); return Object.getPrototypeOf(result) === Object.prototype }",
  ],
  [
    "loaded module export",
    "export async function load(id: string) { const mod = await import(id); return Object.getPrototypeOf(mod.default) === Object.prototype }",
  ],
  [
    "Map.prototype (vitehub agent inline-invoker.ts)",
    "export function f(left: unknown) { const prototype = Object.getPrototypeOf(left); if (prototype === Map.prototype) return 'map' }",
  ],
])("reports %s", async (_name, source) => {
  expect(await run(source)).toHaveLength(1);
});

test.each([
  [
    "typed parameter",
    "export const f = (value: Record<string, unknown>) => Object.getPrototypeOf(value) === Object.prototype",
  ],
  [
    "local object",
    "const value = {}; export const ok = Object.getPrototypeOf(value) === Object.prototype",
  ],
  [
    "realm-safe plain-object check (vitehub internal object.ts)",
    "export function isPlain(value: unknown) { const prototype = Object.getPrototypeOf(value); if (prototype === null) return true; return Object.getPrototypeOf(prototype) === null }",
  ],
  [
    "prototype walk with a reassigned cursor (vitehub agent tool-runtime.ts)",
    "export function f(value: unknown) { let prototype = Object.getPrototypeOf(value); while (prototype && prototype !== Object.prototype) prototype = Object.getPrototypeOf(prototype) }",
  ],
  [
    "user class prototype",
    "class Tool {} export const f = (value: unknown) => Object.getPrototypeOf(value) === Tool.prototype",
  ],
  [
    "shadowed constructor",
    "export function f(value: unknown, Object: { prototype: object, getPrototypeOf(v: unknown): object }) { return Object.getPrototypeOf(value) === Object.prototype }",
  ],
  [
    "constructor source comparison (vitehub sandbox runtime.ts)",
    "export const f = (constructor: unknown) => Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object)",
  ],
  ["constructor name", "export const f = (value: any) => value.constructor.name === 'Object'"],
  [
    "fast path before a brand check",
    "export function isPlain(value: unknown) { if (Object.getPrototypeOf(value) === Object.prototype) return true; return Object.prototype.toString.call(value) === '[object Object]' }",
  ],
  [
    "guard on the same value in the chain",
    "export const f = (value: unknown) => isPlainObject(value) || Object.getPrototypeOf(value) === Object.prototype",
  ],
])("does not report %s", async (_name, source) => {
  expect(await run(source)).toHaveLength(0);
});

test.each([
  [
    "Object",
    "Object.getPrototypeOf(value) === Object.prototype",
    "Check for a plain object without comparing prototypes: const prototype = Object.getPrototypeOf(value); prototype === null || Object.getPrototypeOf(prototype) === null.",
  ],
  [
    "Array",
    "Object.getPrototypeOf(value) === Array.prototype",
    "Replace the Array.prototype comparison with Array.isArray(value), which is true for arrays from any realm.",
  ],
  [
    "Uint8Array",
    "Object.getPrototypeOf(value) === Uint8Array.prototype",
    "Replace the Uint8Array.prototype comparison with a guard helper, isUint8Array(value): value is Uint8Array, that returns ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'.",
  ],
  [
    "constructor",
    "value.constructor === Array",
    "Replace the Array constructor comparison with Array.isArray(value), which is true for arrays from any realm.",
  ],
])("names the realm-safe alternative for %s", async (_name, check, suggestion) => {
  const [diagnostic] = await run(`export const f = (value: any) => ${check}`);
  expect(diagnostic).toMatchObject({ severity: "warn" });
  expect(diagnostic!.suggestion).toBe(suggestion);
});

test.each(["Object.getPrototypeOf(value)", "value.constructor"])(
  "preserves comparison polarity for %s",
  async (identity) => {
    const target = identity === "value.constructor" ? "Array" : "Array.prototype";
    for (const operator of ["!==", "!="]) {
      const check = `${identity} ${operator} ${target}`;
      expect(
        await run(
          `function f(value: any) { if (${check}) throw new Error('array'); if (Array.isArray(value)) return value }`,
        ),
      ).toHaveLength(1);
      expect(
        await run(
          `function f(value: any) { if (${check} && !Array.isArray(value)) throw new Error('array'); return value }`,
        ),
      ).toHaveLength(0);
    }
  },
);

test.each(["Object.getPrototypeOf(value) === Array.prototype", "value.constructor === Array"])(
  "requires a reachable brand fallback for %s",
  async (check) => {
    for (const body of [
      `console.log(Object.prototype.toString.call(value) === '[object Array]'); return ${check}`,
      `if (Object.prototype.toString.call(value) !== '[object Array]') return false; return ${check}`,
      `return Object.prototype.toString.call(value) === '[object Array]' && (${check})`,
    ])
      expect(await run(`function f(value: any) { ${body} }`)).toHaveLength(1);
    expect(
      await run(
        `function f(value: any) { if (${check}) return true; return Object.prototype.toString.call(value) === '[object Array]' }`,
      ),
    ).toHaveLength(0);
  },
);
