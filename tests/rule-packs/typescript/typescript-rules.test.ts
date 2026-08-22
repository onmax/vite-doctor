import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { describe, expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  noCallerChosenResultType,
  noChainedTypeAssertions,
  noConditionalEmptyObjectSpread,
  noObjectParameters,
  noRuntimeTypeof,
  noUnknownTypeAliases,
  noUnvalidatedDeserialization,
  requireSafetyCommentForTypeAssertion,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.ts";

const recommendedRules = [
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
        "typescript/style/no-conditional-empty-object-spread",
        "typescript/strict/no-runtime-typeof",
        "typescript/strict/require-safety-comment-for-type-assertion",
      ]),
    );
  });

  test("reports missing type evidence and unvalidated boundaries", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: recommendedRules,
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
      rules: recommendedRules,
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

  test("distinguishes callback producers from callback consumers", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noCallerChosenResultType],
      files: {
        "src/index.ts": `declare function consume<T>(callback: (value: T) => void): T
declare function produce<T>(factory: () => T): T
declare function parse<T>(text: string, schema: { parse(value: unknown): T }): T
console.log(consume, produce, parse)`,
      },
    });

    expect(result.diagnostics.map((item) => [item.ruleId, item.range?.line])).toEqual([
      ["typescript/evidence/no-caller-chosen-result-type", 1],
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

  test("keeps opinionated checks in the strict preset", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [
        noConditionalEmptyObjectSpread,
        noRuntimeTypeof,
        requireSafetyCommentForTypeAssertion,
      ],
      files: {
        "src/index.ts": `const options = { ...(timeout ? { timeout } : {}) }
if (typeof input === 'string') console.log(input)
const userId = value as UserId
// SAFETY: parseUserId validated this value before branding it.
const safeUserId = parsed as UserId
console.log(options, userId, safeUserId)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId).sort()).toEqual([
      "typescript/strict/no-runtime-typeof",
      "typescript/strict/require-safety-comment-for-type-assertion",
      "typescript/style/no-conditional-empty-object-spread",
    ]);
  });

  test("runs syntax-generic strict rules only in TypeScript sources", async () => {
    const result = await runProjectFixture({
      framework: "vue",
      rules: [noConditionalEmptyObjectSpread, noRuntimeTypeof],
      files: {
        "src/index.js": `const options = { ...(timeout ? { timeout } : {}) }
if (typeof input === "string") console.log(options, input)`,
        "src/index.ts": `const options = { ...(timeout ? { timeout } : {}) }
if (typeof input === "string") console.log(options, input)`,
        "javascript.vue": `<script setup>
const options = { ...(timeout ? { timeout } : {}) }
if (typeof input === "string") console.log(options, input)
</script>`,
        "typescript.vue": `<script setup lang="ts">
const options = { ...(timeout ? { timeout } : {}) }
if (typeof input === "string") console.log(options, input)
</script>`,
      },
    });

    expect(result.diagnostics.map((item) => [item.ruleId, item.file.split("/").at(-1)])).toEqual([
      ["typescript/style/no-conditional-empty-object-spread", "index.ts"],
      ["typescript/style/no-conditional-empty-object-spread", "typescript.vue"],
      ["typescript/strict/no-runtime-typeof", "index.ts"],
      ["typescript/strict/no-runtime-typeof", "typescript.vue"],
    ]);
  });

  test("activates recommended rules automatically for TypeScript only", async () => {
    const typescriptResult = await runBuiltinFixture({
      "src/index.ts": "export function save(value: object) { return value }",
    });
    const javascriptResult = await runBuiltinFixture({
      "src/index.js": "export function save(value) { return value }",
    });

    expect(typescriptResult.diagnostics.map((item) => item.ruleId)).toContain(
      "typescript/evidence/no-object-parameters",
    );
    expect(javascriptResult.diagnostics.some((item) => item.ruleId.startsWith("typescript/"))).toBe(
      false,
    );
  });

  test.each(["mts", "cts"])(
    "scans TypeScript .%s files after automatic activation",
    async (ext) => {
      const result = await runBuiltinFixture({
        [`src/index.${ext}`]: "export function save(value: object) { return value }",
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toContain(
        "typescript/evidence/no-object-parameters",
      );
    },
  );

  test("activates for TypeScript in a Vue SFC without a root tsconfig", async () => {
    const result = await runBuiltinFixture(
      {
        "app.vue": `<script setup lang="ts">
function save(value: object) { return value }
</script>`,
      },
      undefined,
      "vue",
    );

    expect(result.diagnostics.map((item) => item.ruleId)).toContain(
      "typescript/evidence/no-object-parameters",
    );
  });

  test("lets explicit presets compose with automatic activation", async () => {
    const result = await runBuiltinFixture(
      {
        "src/index.ts": "export const kind = typeof input",
      },
      ["auto", "vite-doctor/typescript/strict"],
    );

    expect(result.diagnostics.map((item) => item.ruleId)).toContain(
      "typescript/strict/no-runtime-typeof",
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
