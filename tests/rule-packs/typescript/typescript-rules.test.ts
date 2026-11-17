import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { describe, expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.ts";
import { explainRule } from "../../../src/core/reports.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { getDiagnosticDocuments } from "../../../docs/rules/source.ts";
import {
  noArrayFilterMap,
  noCallerChosenResultType,
  noChainedTypeAssertions,
  noObjectParameters,
  noUnknownTypeAliases,
  noUnvalidatedDeserialization,
  requireSafetyCommentForTypeAssertion,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.ts";

const recommendedRules = [noChainedTypeAssertions, noUnvalidatedDeserialization];

const evidenceRules = [
  noCallerChosenResultType,
  noChainedTypeAssertions,
  noObjectParameters,
  noUnknownTypeAliases,
  noUnvalidatedDeserialization,
];

describe("TypeScript rule pack", () => {
  test("exports conservative recommended and opt-in strict presets", () => {
    expect(typescriptRulePack.name).toBe("vite-doctor/typescript");
    expect(typescriptRulePack.activation).toEqual({ languages: ["typescript"] });
    expect(typescriptRulePack.presets.recommended).toEqual(
      recommendedRules.map((rule) => rule.meta.id),
    );
    expect(typescriptRulePack.presets.strict).toEqual(
      expect.arrayContaining([
        "typescript/evidence/no-caller-chosen-result-type",
        "typescript/evidence/no-object-parameters",
        "typescript/evidence/no-unknown-type-aliases",
        "typescript/strict/require-safety-comment-for-type-assertion",
      ]),
    );
  });

  test.each(["TS0006", "TS0007", "typescript/strict/no-runtime-typeof"])(
    "explain treats removed %s as unknown",
    (diagnostic) => {
      expect(explainRule([typescriptRulePack], diagnostic, "json")).toBe("");
      expect(getDiagnosticDocuments().some((item) => item.code === diagnostic)).toBe(false);
    },
  );

  test("reports recommended syntax-only evidence as warnings", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: recommendedRules,
      files: {
        "src/index.ts": `const driver = (await import("driver")) as unknown as Driver
const user = JSON.parse(text) as User
console.log(driver, user)`,
      },
    });

    expect(result.diagnostics.map((item) => [item.ruleId, item.severity])).toEqual([
      ["typescript/evidence/no-chained-type-assertions", "warn"],
      ["typescript/boundaries/no-unvalidated-deserialization", "warn"],
    ]);
    expect(result.diagnostics[0]?.message).not.toContain("known type");
  });

  test("reports missing type evidence and unvalidated boundaries", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: evidenceRules,
      files: {
        "src/index.ts": `function save(value: BroadObject) {}
function parse<T>(text: string): T { return JSON.parse(text) }
const claimed = input as object as User
const user = JSON.parse(text) as User
type ExternalUser = unknown
type BroadObject = object
console.log(save, parse, claimed, user)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId).sort()).toEqual([
      "typescript/boundaries/no-unvalidated-deserialization",
      "typescript/boundaries/no-unvalidated-deserialization",
      "typescript/evidence/no-caller-chosen-result-type",
      "typescript/evidence/no-chained-type-assertions",
      "typescript/evidence/no-object-parameters",
      "typescript/evidence/no-unknown-type-aliases",
    ]);
    expect(result.diagnostics.every((item) => item.code.startsWith("TS"))).toBe(true);
    expect(result.diagnostics.every((item) => Boolean(item.suggestion))).toBe(true);
  });

  test("accepts concrete contracts and parsed runtime values", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: evidenceRules,
      files: {
        "src/index.ts": `interface SavedRecord { id: string }
function save(value: SavedRecord) {}
function parse<T>(text: string, schema: { parse(value: unknown): T }): T {
  return schema.parse(JSON.parse(text))
}
const raw: unknown = JSON.parse(text)
const user = UserSchema.parse(raw)
const typed: User = codec.json()
function parseUnknown(text: string): unknown { return JSON.parse(text) }
async function parseUnknownAsync(text: string): Promise<unknown> { return JSON.parse(text) }
function parseLocal(JSON: { parse(text: string): User }, text: string): User {
  return JSON.parse(text)
}
const localStorage = { getItem(): User { return user } }
const cached: User = localStorage.getItem()
console.log(save, parse, user, typed, parseUnknown, parseUnknownAsync, parseLocal, cached)`,
      },
    });

    expect(result.diagnostics).toHaveLength(0);
  });

  test("recognizes indirect generic input evidence without flagging type comparisons", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noCallerChosenResultType],
      files: {
        "src/index.ts": `type IfEquals<X, Y, A = true, B = false> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? A : B
declare function map<Keys extends string, KeyArr extends Keys[]>(
  keys: KeyArr
): Record<Keys, string>
function read<E extends "utf8" | false = "utf8">(
  encoding = "utf8" as E
): E extends false ? Uint8Array : string {
  return encoding as E extends false ? Uint8Array : string
}
type UnsafeParser = <T>(text: string) => T
console.log(map, read)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
      "typescript/evidence/no-caller-chosen-result-type",
    ]);
  });

  test("uses returned callable parameters as evidence without trusting their return values", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noCallerChosenResultType],
      files: {
        "src/index.ts": `type Constructor<T> = new (...args: never[]) => T
declare function singleton<T>(): (target: Constructor<T>) => void
declare function factory<T>(): () => T
declare function callbackFactory<T>(): { run(fn: () => Promise<T>): Promise<T> }
declare function objectFactory<T>(): { consume(value: T): void; value: T }
console.log(singleton, factory, callbackFactory, objectFactory)`,
      },
    });

    expect(result.diagnostics.map((item) => [item.ruleId, item.range?.line])).toEqual([
      ["typescript/evidence/no-caller-chosen-result-type", 3],
      ["typescript/evidence/no-caller-chosen-result-type", 5],
    ]);
  });

  test("infers type parameters from callback parameters and results", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noCallerChosenResultType],
      files: {
        "src/index.ts": `declare function consume<T>(callback: (value: T) => void): T
declare function produce<T>(factory: () => T): T
declare function parse<T>(text: string, schema: { parse(value: unknown): T }): T
type Rule<Args extends unknown[], V> = (user: unknown, ...args: Args) => V
export function guest<Args extends unknown[], Verdict extends boolean>(
  rule: (user: unknown, ...args: Args) => Verdict,
): Rule<Args, Verdict> {
  return (user, ...args) => rule(user, ...args)
}
console.log(consume, produce, parse)`,
      },
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("reports a caller-chosen result type as a warning (vitehub forms database.ts:46)", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noCallerChosenResultType],
      files: {
        "src/index.ts": `export function parse<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T
}`,
      },
    });

    expect(result.diagnostics.map((item) => [item.code, item.severity, item.range?.line])).toEqual([
      ["TS0004", "warn", 1],
    ]);
  });

  test("reports deserialization returned under an explicit type", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `function parseUser(text: string): User {
  return JSON.parse(text)
}
const parseAccount = (text: string): Account => JSON.parse(text)
console.log(parseUser, parseAccount)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
      "typescript/boundaries/no-unvalidated-deserialization",
      "typescript/boundaries/no-unvalidated-deserialization",
    ]);
  });

  test("reports deserialization assigned to an explicitly typed class property", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `class SessionCache {
  user: User = JSON.parse("{}")
}
console.log(SessionCache)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
      "typescript/boundaries/no-unvalidated-deserialization",
    ]);
  });

  test("reports deserialization assigned through an explicitly typed pattern", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `const { id }: User = JSON.parse(text)
const [first]: [User] = JSON.parse(text)
console.log(id, first)`,
      },
    });

    expect(result.diagnostics.map((item) => [item.ruleId, item.range?.line])).toEqual([
      ["typescript/boundaries/no-unvalidated-deserialization", 1],
      ["typescript/boundaries/no-unvalidated-deserialization", 2],
    ]);
  });

  test("ignores owned JSON serialization round trips", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `interface Snapshot { id: string }
function clone(value: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(value))
}
const qualified: Snapshot = globalThis.JSON.parse(globalThis.JSON.stringify(value))
function parse(text: string): Snapshot {
  return JSON.parse(text)
}
console.log(clone, qualified, parse)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
      "typescript/boundaries/no-unvalidated-deserialization",
    ]);
  });

  test("recognizes qualified global deserializers without flagging shadowed roots", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `const cached = window.localStorage.getItem("user") as User
const parsed: User = globalThis.JSON.parse(text)
function readSession(): User {
  return globalThis.sessionStorage.getItem("user") as User
}
function readLocal(window: { localStorage: { getItem(key: string): User } }): User {
  return window.localStorage.getItem("user") as User
}
function parseLocal(globalThis: { JSON: { parse(text: string): User } }): User {
  return globalThis.JSON.parse(text) as User
}
console.log(cached, parsed, readSession, readLocal, parseLocal)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
      "typescript/boundaries/no-unvalidated-deserialization",
      "typescript/boundaries/no-unvalidated-deserialization",
      "typescript/boundaries/no-unvalidated-deserialization",
    ]);
  });

  test("reports Fetch API bodies typed without validation", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `export async function readPayload<T>(request: Request): Promise<T> {
  return await request.json() as T
}
export async function loadUser(url: string): Promise<User> {
  const response = await fetch(url)
  return await response.json()
}
export async function loadAccount(url: string) {
  const account: Account = await (await fetch(url)).json()
  return account
}
export function readBody(response: Response): Promise<Session> {
  return response.json()
}
export async function loadGlobal(url: string) {
  const response = await globalThis.fetch(url)
  const windowed = await window.fetch(url)
  return [await response.json() as User, await windowed.json() as User]
}`,
      },
    });

    expect(result.diagnostics.map((item) => [item.ruleId, item.range?.line])).toEqual([
      ["typescript/boundaries/no-unvalidated-deserialization", 2],
      ["typescript/boundaries/no-unvalidated-deserialization", 6],
      ["typescript/boundaries/no-unvalidated-deserialization", 9],
      ["typescript/boundaries/no-unvalidated-deserialization", 13],
      ["typescript/boundaries/no-unvalidated-deserialization", 18],
      ["typescript/boundaries/no-unvalidated-deserialization", 18],
    ]);
  });

  test("ignores json() on imported Request and Response types", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `import { Response } from "./api"
import Request from "./request"
export function read(response: Response): Promise<User> {
  return response.json()
}
export function readRequest(request: Request): Promise<User> {
  return request.json()
}
export async function readShadowed(url: string, globalThis: { fetch(url: string): Promise<Store> }) {
  const store = await globalThis.fetch(url)
  return await store.json() as User
}
export async function readReassigned(url: string) {
  globalThis.fetch = fetch
  const response = await globalThis.fetch(url)
  return await response.json() as User
}`,
      },
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("reports direct Fetch bodies with imported annotations", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `import { Response } from "./api"
export async function read(url: string): Promise<User> {
  const response: Response = await globalThis.fetch(url)
  return response.json()
}`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
      "typescript/boundaries/no-unvalidated-deserialization",
    ]);
  });

  test("accepts JSON types that claim nothing about the contents", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `import type { JsonValue as FestJson } from "type-fest"
import type { JsonValue } from "@acme/internal/config-edit"
import type { Json as SharedJson } from "./json"
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
const list = JSON.parse(text) as unknown[]
const frozen = JSON.parse(text) as readonly unknown[]
const generic = JSON.parse(text) as Array<unknown>
const record: Record<string, unknown> = JSON.parse(text)
const nullable = JSON.parse(text) as Record<string, unknown> | null
const marker = JSON.parse(text) as { digest?: unknown }
const event = JSON.parse(text) as { pull_request?: { head?: { sha?: unknown } } }
const local = JSON.parse(text) as Json
const workspace: JsonValue = JSON.parse(text)
const fest = JSON.parse(text) as FestJson
const shared: SharedJson = JSON.parse(text)
function stored(): string | null {
  return localStorage.getItem("dock")
}
const session: string | null | undefined = sessionStorage.getItem("dock")
async function body(response: Response): Promise<Json[]> {
  return response.json()
}
console.log(list, frozen, generic, record, nullable, marker, event, local, workspace, fest, shared, stored, session, body)`,
        "src/json.ts": `export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }`,
        "node_modules/@acme/internal/package.json": JSON.stringify({
          name: "@acme/internal",
          exports: {
            "./config-edit": {
              types: "./dist/config-edit.d.ts",
              import: "./dist/config-edit.js",
            },
          },
        }),
        "node_modules/@acme/internal/src/config-edit.ts": `export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }`,
      },
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("reports types that claim more than the deserialized value proves", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `import type { Manifest } from "./manifest"
import type { JsonValue } from "./fake-json"
type Scalar = string | number
const scalar = JSON.parse(text) as Scalar
const names = JSON.parse(text) as string[]
const labels = JSON.parse(text) as Record<string, string>
const user = JSON.parse(text) as { id: string; extra?: unknown }
const token = localStorage.getItem("token") as string
const manifest: Manifest = JSON.parse(text)
const fake: JsonValue = JSON.parse(text)
async function read<T = unknown>(request: Request): Promise<T> {
  return await request.json() as T
}
console.log(scalar, names, labels, user, token, manifest, fake, read)`,
        "src/manifest.ts": `export interface Manifest { name: string }`,
        "src/fake-json.ts": `export type JsonValue = { id: string }`,
      },
    });

    expect(result.diagnostics.map((item) => item.range?.line)).toEqual([4, 5, 6, 7, 8, 9, 10, 12]);
  });

  test("preserves alias constraints, lexical bindings, recursion and promise contracts", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `import type { Nullable, Mixed } from "./aliases"
type Raw = unknown[] | { id: string }
type Maybe = unknown[] | null | undefined
type Nested = Nested[]
type Tree = { [key: string]: Tree }
type Payload = unknown
type Record<K extends string, V> = { id: string; value: V }
const a = JSON.parse(text) as Raw
const b = JSON.parse(text) as Maybe
const c = JSON.parse(text) as Nested
const d = JSON.parse(text) as Tree
function parse<Payload>(text: string): Payload { return JSON.parse(text) }
const e = JSON.parse(text) as Record<string, unknown>
function sync(text: string): Promise<unknown> { return JSON.parse(text) }
const arrow = (text: string): Promise<unknown> => JSON.parse(text)
function fetchBody(response: Response): Promise<unknown> { return response.json() }
async function asyncBody(text: string): Promise<unknown> { return JSON.parse(text) }
const f = JSON.parse(text) as Nullable
const g = JSON.parse(text) as Mixed
function local() {
  type Payload = { id: string }
  return JSON.parse(text) as Payload
}
console.log(a, b, c, d, e, f, g, parse, sync, arrow, fetchBody, asyncBody, local)`,
        "src/aliases.ts": `export type Nullable = unknown[] | null
export type Mixed = unknown[] | { id: string }`,
      },
    });
    expect(result.diagnostics.map((item) => item.range?.line)).toEqual([
      8, 10, 11, 12, 13, 14, 15, 19, 22,
    ]);
  });

  test.each(["d.ts", "d.mts", "d.cts"])(
    "resolves implicit package declaration exports in %s",
    async (extension) => {
      const result = await runProjectFixture({
        framework: "vite",
        rules: [noUnvalidatedDeserialization],
        files: {
          "src/index.ts": `import type { JsonValue, Raw } from "honest-json";
import type { JsonValue as ViaBarrel, Raw as BarrelRaw } from "./barrel";
import type { Hidden } from "private-json";
const direct = JSON.parse(text) as JsonValue;
const barrel = JSON.parse(text) as ViaBarrel;
const container = JSON.parse(text) as Raw;
const barrelContainer = JSON.parse(text) as BarrelRaw;
const hidden = JSON.parse(text) as Hidden;`,
          "src/barrel.ts": 'export * from "honest-json";',
          "node_modules/honest-json/package.json": JSON.stringify({
            name: "honest-json",
            types: `index.${extension}`,
          }),
          [`node_modules/honest-json/index.${extension}`]: `type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Raw = unknown[] | null;
export type Other = number;`,
          "node_modules/private-json/package.json": JSON.stringify({
            name: "private-json",
            types: `index.${extension}`,
          }),
          [`node_modules/private-json/index.${extension}`]: `type Hidden = unknown;
export {};`,
        },
      });
      expect(result.diagnostics.map((item) => item.range?.line)).toEqual([8]);
    },
  );

  test.each(["d.ts", "d.mts", "d.cts"])(
    "distinguishes default assignments from declarations in %s",
    async (extension) => {
      const result = await runProjectFixture({
        framework: "vite",
        rules: [noUnvalidatedDeserialization],
        files: {
          "src/index.ts": `import type { Raw } from "./barrel";
import type { Honest as ClassHonest } from "./class";
import type { Honest as FunctionHonest } from "./function";
const value = JSON.parse(text) as Raw;
const classValue = JSON.parse(text) as ClassHonest;
const functionValue = JSON.parse(text) as FunctionHonest;`,
          "src/barrel.ts": 'export * from "./first"; export * from "./second";',
          [`src/first.${extension}`]: `type Raw = { id: string };
declare const other: number;
export default other;`,
          "src/second.ts": "export type Raw = unknown[];",
          [`src/class.${extension}`]: `type Honest = unknown[];
export default class Other {}`,
          [`src/function.${extension}`]: `type Honest = unknown[];
export default function other(): number;`,
        },
      });
      expect(result.diagnostics).toEqual([]);
    },
  );

  test.each([
    "type Raw = { id: string }; export type Other = number;",
    'import type { Raw } from "./private"; export type Other = number;',
    "export function other() { interface Raw { id: string } }",
  ])("ignores private wildcard bindings: %s", async (first) => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `import type { Raw } from "./barrel";
const value = JSON.parse(text) as Raw;`,
        "src/barrel.ts": 'export * from "./first"; export * from "./second";',
        "src/first.ts": first,
        "src/second.ts": "type Honest = unknown[]; export { Honest as Raw };",
        "src/private.ts": "export type Raw = { id: string };",
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each([false, true])(
    "resolves explicit recursive reexports before stars (reversed: %s)",
    async (reversed) => {
      const exports = ['export * from "./first";', 'export { B } from "./second";'];
      const result = await runProjectFixture({
        framework: "vite",
        rules: [noUnvalidatedDeserialization],
        files: {
          "src/index.ts": `import type { B } from "./barrel";
export type A = string | number | boolean | null | { [key: string]: unknown } | B[] | { recursive: C };
export type C = A;
const value = JSON.parse(text) as A;`,
          "src/barrel.ts": (reversed ? exports.reverse() : exports).join("\n"),
          "src/first.ts": `import type { A } from "./index"; export type B = A[];`,
          "src/second.ts": `export type B = unknown;`,
        },
      });
      expect(result.diagnostics).toEqual([]);
    },
  );

  test("names the source and the declared type in the message", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `const manifest: Manifest = JSON.parse(text)
const token = localStorage.getItem("token") as string
async function read(request: Request): Promise<Payload> {
  return request.json()
}
console.log(manifest, token, read)`,
      },
    });

    const messages = result.diagnostics.map((item) => item.message);
    expect(messages[0]).toContain("`JSON.parse()`");
    expect(messages[0]).toContain("`Manifest`");
    expect(messages[1]).toContain("`localStorage.getItem()`");
    expect(messages[1]).toContain("`string | null`");
    expect(messages[1]).toContain("`string`");
    expect(messages[2]).toContain("`request.json()`");
    expect(messages[2]).toContain("`Payload`");
  });

  test("ignores json() calls without Fetch API evidence or a type claim", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnvalidatedDeserialization],
      files: {
        "src/index.ts": `export async function load(client: ApiClient, url: string, text: string, fetch: (url: string) => Promise<Store>) {
  const user = await client.json() as User
  const store = await fetch(url)
  const items = await store.json() as Item[]
  const response = await globalThis.fetch(url)
  const raw = await response.json()
  const validated = UserSchema.parse(await response.json())
  const unknownBody = await response.json() as unknown
  const identity = (await response.json()) as { email?: unknown; profile?: { name?: unknown } } | null
  const parsed: { id?: unknown } | null = JSON.parse(text)
  const error = await response.json().catch(() => undefined) as { message?: string } | undefined
  return { user, items, raw, validated, unknownBody, identity, parsed, error }
}`,
      },
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("keeps opinionated checks in the strict preset", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [requireSafetyCommentForTypeAssertion],
      files: {
        "src/index.ts": `const userId = value as UserId
// SAFETY: parseUserId validated this value before branding it.
const safeUserId = parsed as UserId
console.log(userId, safeUserId)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
      "typescript/strict/require-safety-comment-for-type-assertion",
    ]);
  });

  test("runs syntax-generic strict rules only in TypeScript sources", async () => {
    const source = "[1, 2].filter(keep).map(transform)";
    const result = await runProjectFixture({
      framework: "vue",
      rules: [noArrayFilterMap],
      files: {
        "src/index.js": source,
        "src/index.ts": source,
        "javascript.vue": `<script setup>\n${source}\n</script>`,
        "typescript.vue": `<script setup lang="ts">\n${source}\n</script>`,
      },
    });

    expect(result.diagnostics.map((item) => [item.ruleId, item.file.split("/").at(-1)])).toEqual([
      ["typescript/performance/no-array-filter-map", "index.ts"],
      ["typescript/performance/no-array-filter-map", "typescript.vue"],
    ]);
  });

  test("activates recommended rules automatically for TypeScript only", async () => {
    const typescriptResult = await runBuiltinFixture({
      "src/index.ts": "export const user = input as object as User",
    });
    const javascriptResult = await runBuiltinFixture({
      "src/index.js": "export function save(value) { return value }",
    });

    expect(typescriptResult.diagnostics.map((item) => item.ruleId)).toContain(
      "typescript/evidence/no-chained-type-assertions",
    );
    expect(javascriptResult.diagnostics.some((item) => item.ruleId.startsWith("typescript/"))).toBe(
      false,
    );
  });

  test.each(["mts", "cts"])(
    "scans TypeScript .%s files after automatic activation",
    async (ext) => {
      const result = await runBuiltinFixture({
        [`src/index.${ext}`]: "export const user = input as object as User",
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toContain(
        "typescript/evidence/no-chained-type-assertions",
      );
    },
  );

  test("activates for TypeScript in a Vue SFC without a root tsconfig", async () => {
    const result = await runBuiltinFixture(
      {
        "app.vue": `<script setup lang="ts">
const user = input as object as User
</script>`,
      },
      undefined,
      "vue",
    );

    expect(result.diagnostics.map((item) => item.ruleId)).toContain(
      "typescript/evidence/no-chained-type-assertions",
    );
  });

  test("lets explicit presets compose with automatic activation", async () => {
    const result = await runBuiltinFixture(
      {
        "src/index.ts": "export const userId = value as UserId",
      },
      ["auto", "vite-doctor/typescript/strict"],
    );

    expect(result.diagnostics.map((item) => item.ruleId)).toContain(
      "typescript/strict/require-safety-comment-for-type-assertion",
    );
  });
});

async function runBuiltinFixture(
  files: Record<string, string>,
  extend?: string[],
  framework: "vite" | "vue" = "vite",
) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-typescript-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        type: "module",
        devDependencies: framework === "vue" ? { vue: "^3.5.0" } : { vite: "^8.0.0" },
      }),
    );
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    return await runViteDoctor({ root, cache: false, framework, extends: extend });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
