import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noRuntimeObjectDefine, noSecretDefine } from "../../src/rule-packs/vite/rules/define.ts";

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
  ["const { PUBLIC_VERSION: replacement = process.env.PRIVATE_TOKEN } = process.env", true],
  ["const { PUBLIC_VERSION: replacement = import.meta.env.PRIVATE_TOKEN } = import.meta.env", true],
  [
    "const fallback = process.env.PRIVATE_TOKEN; const { PUBLIC_VERSION: replacement = fallback } = process.env",
    true,
  ],
  [
    "const fallback = process.env.PUBLIC_VERSION; const { PUBLIC_VERSION: replacement = fallback } = process.env",
    false,
  ],
  [
    "const fallback = replacement; const { PUBLIC_VERSION: replacement = fallback } = process.env",
    false,
  ],
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

test.each([
  'JSON.stringify(replacement ?? "")',
  'JSON.stringify(replacement + "")',
  'JSON.stringify(enabled ? replacement : "")',
  "JSON.stringify([replacement])",
  "JSON.stringify({ replacement })",
  "JSON.stringify([0, replacement])",
  "JSON.stringify({ nested: { value: replacement }, public: true })",
  "JSON.stringify({\n    replacement,\n  })",
  "JSON.stringify((0, replacement))",
])("traces aliases in compound replacements: %s", async (expression) => {
  for (const source of ["PRIVATE_TOKEN", "PUBLIC_VERSION"]) {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `const original = process.env.${source}
const replacement = original ?? ""
export default { define: {
  __CONFIG__: ${expression},
} }`,
      },
    });
    expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(
      source === "PRIVATE_TOKEN",
    );
  }
});

test.each([
  'JSON.stringify(publicValues.replacement ?? "")',
  "JSON.stringify(publicValue as typeof replacement)",
  "JSON.stringify(typeof replacement)",
  "JSON.stringify(void replacement)",
  "JSON.stringify(!replacement)",
  "JSON.stringify(replacement === 'present')",
  "JSON.stringify(replacement ? 'present' : 'absent')",
  "JSON.stringify((replacement, 'public'))",
])("does not trace references that cannot expose their value: %s", async (expression) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = process.env.PRIVATE_TOKEN
export default { define: {
  __CONFIG__: ${expression},
} }`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("follows long immutable alias chains", async () => {
  const declarations = ["const value0 = process.env.PRIVATE_TOKEN"];
  for (let index = 1; index < 100; index++) {
    declarations.push(`const value${index} = value${index - 1}`);
  }
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declarations.join("\n")}
export default { define: {
  __CONFIG__: JSON.stringify(value99),
} }`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(noSecretDefine.meta.id);
});

test("preserves direct diagnostics when alias scope parsing fails", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const legacyOctal = 01
export default { define: {
  __CONFIG__: JSON.stringify(process.env.PRIVATE_TOKEN),
} }`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(noSecretDefine.meta.id);
});

test("does not trace a typeof transform in an intermediate alias", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const original = process.env.PRIVATE_TOKEN
const replacement = typeof original
export default { define: { __CONFIG__: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "typeof privateToken",
  "void privateToken",
  "!privateToken",
  "privateToken === 'present'",
  "privateToken ? 'present' : 'absent'",
  "(privateToken, 'public')",
  "{ callback: () => privateToken }",
  "{ callback: function () { return privateToken } }",
  "{ callback() { return privateToken } }",
])("filters non-propagating initializers before secret names: %s", async (initializer) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const privateToken = process.env.PRIVATE_TOKEN
const replacement = ${initializer}
export default { define: { __CONFIG__: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["{ callback: () => replacement }", false],
  ["{ callback: function () { return replacement } }", false],
  ["(() => replacement)()", true],
  ["(function () { return replacement })()", true],
  ["read()", true],
  ["{ callback: read }", false],
  ["(function () { const unused = replacement; return 'public' })()", false],
])("traces function bodies only when invoked: %s", async (expression, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = process.env.PRIVATE_TOKEN
const read = () => replacement
export default { define: { __CONFIG__: JSON.stringify(${expression}) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    "export default { define: { __VERSION__: '1' }, plugins: [options] }",
    "export default defineConfig(() => { const nested = { define: { PRIVATE_TOKEN: {} } }; return { define: { __VERSION__: '1' }, plugins: [options, nested] } })",
  ])(`${rule.meta.id} ignores unrelated define properties: %s`, async (config) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": `const options = { define: { PRIVATE_TOKEN: {} } }; ${config}` },
    });
    expect(result.diagnostics).toEqual([]);
  });
  test("recognizes CommonJS config exports for " + rule.meta.id, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.cjs": "module.exports = { define: { PRIVATE_TOKEN: {} } }" },
    });
    expect(result.diagnostics.length).toBe(1);
  });
  test.each([
    "export default { define: { PRIVATE_TOKEN: {} } }",
    "export default defineConfig({ define: { PRIVATE_TOKEN: {} } })",
    "export default defineConfig(() => ({ define: { PRIVATE_TOKEN: {} } }))",
    "export default defineConfig(function () { return { define: { PRIVATE_TOKEN: {} } } })",
    "const config = { define: { PRIVATE_TOKEN: {} } }; export default config",
    "const values = { PRIVATE_TOKEN: {} }; export default { define: values }",
  ])(`${rule.meta.id} retains exported config forms: %s`, async (config) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": config },
    });
    expect(result.diagnostics.length).toBe(1);
  });
}

test.each([
  ["const PASSWORD = '__VERSION__'", "PASSWORD", false],
  ["const key = 'PRIVATE_TOKEN'", "key", true],
  ["", "'PRIVATE_TOKEN'", true],
  ["const PASSWORD = getKey()", "PASSWORD", false],
])("uses static computed keys: %s", async (declaration, key, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declaration}; export default { define: { [${key}]: JSON.stringify('1') } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});
