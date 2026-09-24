import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noSecretDefine } from "../../src/rule-packs/vite/rules/define.ts";

test("finds a secret source hidden behind local define aliases", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const privateValue = process.env.PRIVATE_TOKEN
const replacement = privateValue
export default { define: {
  __CONFIG__: JSON.stringify(replacement),
} }`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(noSecretDefine.meta.id);
});

test("does not classify a public local alias as a secret", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = process.env.PUBLIC_VERSION
export default { define: {
  __CONFIG__: JSON.stringify(replacement),
} }`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(false);
});

for (const scope of ["function helper()", ""]) {
  test.each([
    ["PUBLIC_VERSION", "PRIVATE_TOKEN", true],
    ["PRIVATE_TOKEN", "PUBLIC_VERSION", false],
  ])(
    "resolves the outer binding after %s shadowing in " + (scope || "a block"),
    async (inner, outer, expected) => {
      const result = await runRuleFixture({
        framework: "vite",
        rule: noSecretDefine,
        files: {
          "vite.config.ts": `${scope} { const replacement = process.env.${inner} }
const replacement = process.env.${outer}
export default { define: {
  __CONFIG__: JSON.stringify(replacement),
} }`,
        },
      });
      expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(
        expected,
      );
    },
  );
}

test("follows each alias in its declaration scope", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const value = process.env.PRIVATE_TOKEN
const replacement = value
export default defineConfig(() => {
  const value = process.env.PUBLIC_VERSION
  return { define: {
    __CONFIG__: JSON.stringify(replacement),
  } }
})`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(true);
});

test("does not follow an outer alias through a shadowing parameter", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = process.env.PRIVATE_TOKEN
export default defineConfig((replacement) => ({ define: {
  __CONFIG__: JSON.stringify(replacement),
} }))`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(false);
});

test("stops at cyclic aliases", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const first = second
const second = first
export default { define: {
  __CONFIG__: JSON.stringify(first),
} }`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["PRIVATE_TOKEN", "PUBLIC_VERSION", false],
  ["PUBLIC_VERSION", "PRIVATE_TOKEN", true],
])("uses the inner binding when the outer source is %s", async (outer, inner, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = process.env.${outer}
export default defineConfig(() => {
  const replacement = process.env.${inner}
  return { define: {
    __CONFIG__: JSON.stringify(replacement),
  } }
})`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(expected);
});

test.each([
  "let replacement = process.env.PRIVATE_TOKEN; replacement = process.env.PUBLIC_VERSION",
  "let replacement = process.env.PUBLIC_VERSION; replacement = process.env.PRIVATE_TOKEN",
  "var replacement = process.env.PRIVATE_TOKEN; var replacement = process.env.PUBLIC_VERSION",
  "var replacement = process.env.PUBLIC_VERSION; var replacement = process.env.PRIVATE_TOKEN",
])("does not infer a mutable alias from its initializer: %s", async (declarations) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declarations}
export default { define: {
  __CONFIG__: JSON.stringify(replacement),
} }`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

for (const expression of [
  "replacement as string",
  "replacement!",
  "<string>replacement",
  "replacement satisfies string",
  "(replacement as string)!",
]) {
  test.each(["PRIVATE_TOKEN", "PUBLIC_VERSION"])(
    `follows TypeScript wrappers in aliases and define values: ${expression}, %s`,
    async (source) => {
      const result = await runRuleFixture({
        framework: "vite",
        rule: noSecretDefine,
        files: {
          "vite.config.ts": `const original = process.env.${source}
const replacement = (original as string)!
export default { define: {
  __CONFIG__: JSON.stringify(${expression}),
} }`,
        },
      });
      expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(
        source === "PRIVATE_TOKEN",
      );
    },
  );
}

test.each([
  ["const { PRIVATE_TOKEN: replacement } = process.env", true],
  ["const { PUBLIC_VERSION: replacement, PRIVATE_TOKEN: other } = process.env", false],
  ["const { 'PRIVATE_TOKEN': replacement } = process.env", true],
  ["const { ['PRIVATE_TOKEN']: replacement } = process.env", true],
  ["const { PRIVATE_TOKEN: replacement } = import.meta.env", true],
  ["const { PRIVATE_TOKEN: replacement = '' } = process.env", true],
  ["const { PRIVATE_TOKEN: replacement = 'fallback' } = import.meta.env", true],
  ["const { ['PRIVATE_TOKEN']: replacement = '' } = process.env", true],
  ["const { PUBLIC_VERSION: replacement = 'fallback' } = process.env", false],
  ["let { PRIVATE_TOKEN: replacement = '' } = process.env; replacement = 'public'", false],
  ["const key = 'PRIVATE_TOKEN'; const { [key]: replacement = '' } = process.env", false],
  ["let { PRIVATE_TOKEN: replacement } = process.env; replacement = 'public'", false],
  ["const { PRIVATE_TOKEN: other, ...replacement } = process.env", false],
  ["const key = 'PRIVATE_TOKEN'; const { [key]: replacement } = process.env", false],
])("resolves static renamed environment bindings: %s", async (declaration, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declaration}
const value = replacement
export default { define: {
  __CONFIG__: JSON.stringify(value),
} }`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(expected);
});

test.each([
  ["PRIVATE_TOKEN", "PUBLIC_VERSION", false],
  ["PUBLIC_VERSION", "PRIVATE_TOKEN", true],
])("resolves shadowed destructured bindings with outer %s", async (outer, inner, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const { ${outer}: replacement } = process.env
export default defineConfig(() => {
  const { ${inner}: replacement } = process.env
  return { define: {
    __CONFIG__: JSON.stringify(replacement),
  } }
})`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(expected);
});
