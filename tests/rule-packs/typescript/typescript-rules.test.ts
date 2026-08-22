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
console.log(save, parse, user)`,
      },
    });

    expect(result.diagnostics).toHaveLength(0);
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

async function runBuiltinFixture(files: Record<string, string>, extend?: string[]) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-typescript-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", devDependencies: { vite: "^8.0.0" } }),
    );
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    return await runViteDoctor({ root, cache: false, framework: "vite", extends: extend });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
