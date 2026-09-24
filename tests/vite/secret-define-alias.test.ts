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
import { defineConfig } from 'vite'; export default defineConfig(() => {
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
import { defineConfig } from 'vite'; export default defineConfig((replacement) => ({ define: {
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
import { defineConfig } from 'vite'; export default defineConfig(() => {
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
import { defineConfig } from 'vite'; export default defineConfig(() => {
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
    "const base = { define: { PRIVATE_TOKEN: {} } }; export default { ...base, define: {} }",
    "export default { define: { __VERSION__: '1' }, plugins: [options] }",
    "import { defineConfig } from 'vite'; export default defineConfig(() => { const nested = { define: { PRIVATE_TOKEN: {} } }; return { define: { __VERSION__: '1' }, plugins: [options, nested] } })",
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
    "import { defineConfig } from 'vite'; export default defineConfig({ define: { PRIVATE_TOKEN: {} } })",
    "import { defineConfig } from 'vite'; export default defineConfig(() => ({ define: { PRIVATE_TOKEN: {} } }))",
    "import { defineConfig } from 'vite'; export default defineConfig(function () { return { define: { PRIVATE_TOKEN: {} } } })",
    "const config = { define: { PRIVATE_TOKEN: {} } }; export default config",
    "const config = { define: { PRIVATE_TOKEN: {} } }; export default { ...config }",
    "export default function config() { return { define: { PRIVATE_TOKEN: {} } } }",
    "function config() { return { define: { PRIVATE_TOKEN: {} } } }; export default config",
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

test.each([
  ["reader.read()", true],
  ["reader['read']()", true],
  ["reader.publicValue()", false],
  ["reader.read", false],
  ["reader", false],
  ["read()", true],
  ["read", false],
  ["{ [replacement]: true }", true],
  ["replacement.length", false],
  ["replacement['length']", false],
])("traces local methods, declarations and computed keys: %s", async (expression, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = process.env.PRIVATE_TOKEN
function read() { return replacement }
const reader = { read() { return replacement }, publicValue() { return 'public' } }
export default { define: { __CONFIG__: JSON.stringify(${expression}) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["const base = { read() { return replacement } }; const reader = { ...base }", true],
  [
    "const base = { read() { return 'public' } }; const reader = { read() { return replacement }, ...base }",
    false,
  ],
  [
    "const base = { read() { return replacement } }; const reader = { read() { return 'public' }, ...base }",
    true,
  ],
  [
    "const base = { read() { return replacement } }; const reader = { ...base, read() { return 'public' } }",
    false,
  ],
  [
    "const base = { read() { return replacement } }; const middle = { ...base }; const reader = { ...middle }",
    true,
  ],
])("preserves method spread order: %s", async (declaration, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = process.env.PRIVATE_TOKEN; ${declaration}; export default { define: { __CONFIG__: JSON.stringify(reader.read()) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["const read = async () => replacement", "read()", false],
  ["const read = async () => replacement", "await read()", true],
  ["async function read() { return replacement }", "read()", false],
  ["async function read() { return replacement }", "await read()", true],
  ["function* read() { return replacement }", "read()", false],
  ["const reader = { async read() { return replacement } }", "reader.read()", false],
  ["const reader = { async read() { return replacement } }", "await reader.read()", true],
  ["const reader = { *read() { return replacement } }", "reader.read()", false],
  ["", "process.env[`PRIVATE_TOKEN`]", true],
  ["", "process.env[`PUBLIC_VALUE`]", false],
])(
  "handles resolved values and static template keys: %s %s",
  async (declaration, expression, expected) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `const replacement = process.env.PRIVATE_TOKEN; ${declaration}; export default { define: { __CONFIG__: JSON.stringify(${expression}) } }`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  },
);

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    ["const defs = { PRIVATE_TOKEN: {} }; export default { define: { ...defs } }", 1],
    ["const defs = { __CONFIG__: {} }; export default { define: { ...defs, __CONFIG__: '1' } }", 0],
    [
      "const defs = { PRIVATE_TOKEN: {} }; const nested = { ...defs }; export default { define: { ...nested } }",
      1,
    ],
    ["const config = { define: { PRIVATE_TOKEN: {} } }; export { config as default }", 1],
  ])(`${rule.meta.id} resolves define spreads and named defaults: %s`, async (config, count) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": config },
    });
    expect(result.diagnostics).toHaveLength(count);
  });
}

test.each([
  ["...defs, __CONFIG__: JSON.stringify('public')", false],
  ["__CONFIG__: JSON.stringify('public'), ...defs", true],
])("honors define replacement overwrite order: %s", async (properties, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const defs = { __CONFIG__: JSON.stringify(process.env.PRIVATE_TOKEN) }; export default { define: { ${properties} } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  [
    "const inner = async () => process.env.PRIVATE_TOKEN; const outer = async () => inner()",
    "await outer()",
    true,
  ],
  [
    "const inner = async () => process.env.PRIVATE_TOKEN; const outer = async () => inner()",
    "outer()",
    false,
  ],
  ["const value = process.env.PRIVATE_TOKEN", "Promise.resolve(value)", false],
  ["const value = process.env.PRIVATE_TOKEN", "await Promise.resolve(value)", true],
  ["const inner = async () => process.env.PRIVATE_TOKEN", "await Promise.resolve(inner())", true],
  ["const value = process.env.PRIVATE_TOKEN", "await Promise.reject(value)", false],
  ["const holder = { get value() { return process.env.PRIVATE_TOKEN } }", "holder.value", true],
  ["const holder = { get value() { return process.env.PUBLIC_VERSION } }", "holder.value", false],
  [
    "const holder = { get unused() { return process.env.PRIVATE_TOKEN }, value: 'public' }",
    "holder.value",
    false,
  ],
  ["const read = (value = process.env.PRIVATE_TOKEN) => value", "read()", true],
  ["const read = (value = process.env.PRIVATE_TOKEN) => value", "read(undefined)", true],
  ["const read = (value = process.env.PRIVATE_TOKEN) => value", "read('public')", false],
  ["const read = (value = process.env.PRIVATE_TOKEN) => 'public'", "read()", false],
  [
    "const read = (value = process.env.PRIVATE_TOKEN) => value; const other = read",
    "other()",
    true,
  ],
  [
    "const holder = { read(value = process.env.PRIVATE_TOKEN) { return value } }",
    "holder.read()",
    true,
  ],
  [
    "const holder = { read(value = process.env.PRIVATE_TOKEN) { return value } }",
    "holder.read('public')",
    false,
  ],
])("traces invoked values: %s / %s", async (declarations, value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declarations}; export default async () => ({ define: { __CONFIG__: JSON.stringify(${value}) } })`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noRuntimeObjectDefine, noSecretDefine]) {
  test.each([
    'import { defineConfig as config } from "vite"; export default config({ define: { PRIVATE_TOKEN: {} } })',
    "import { defineConfig } from 'vite'; export default defineConfig(async () => { return await Promise.resolve({ define: { PRIVATE_TOKEN: {} } }) })",
    "import { defineConfig } from 'vite'; export default defineConfig(async () => Promise.resolve({ define: { PRIVATE_TOKEN: {} } }))",
    "export default Promise.resolve({ define: { PRIVATE_TOKEN: {} } })",
  ])(`${rule.meta.id} discovers wrapped configs: %s`, async (config) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": config },
    });
    expect(result.diagnostics).toHaveLength(1);
  });
}

test.each([
  ["const read = async (value) => value", "read(process.env.PRIVATE_TOKEN)", false],
  ["const read = async (value) => value", "await read(process.env.PRIVATE_TOKEN)", true],
  ["const holder = { read: () => process.env.PRIVATE_TOKEN }", "holder.read()", true],
  [
    "const holder = { async read() { return Promise.resolve(process.env.PRIVATE_TOKEN) } }",
    "await holder.read()",
    true,
  ],
  ["const read = (value = process.env.PRIVATE_TOKEN) => value", "[read('public'), read()]", true],
  ["const read = (value = process.env.PRIVATE_TOKEN) => value", "[read(), read('public')]", true],
  ["const read = (value = 'public') => read(value)", "read()", false],
  ["const serialize = JSON.stringify", "serialize(process.env.PRIVATE_TOKEN)", true],
])("keeps invocation context: %s / %s", async (declarations, value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declarations}; export default async () => ({ define: { __CONFIG__: JSON.stringify(${value}) } })`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["const read = ({ value }) => value;", "read({ value: process.env.PRIVATE_TOKEN })", true],
  [
    "const read = ({ value }) => value;",
    "read({ other: process.env.PRIVATE_TOKEN, value: 'public' })",
    false,
  ],
  ["const factory = () => (value = process.env.PRIVATE_TOKEN) => value;", "factory()()", true],
  [
    "const factory = () => (value = process.env.PRIVATE_TOKEN) => value;",
    "factory()('public')",
    false,
  ],
  ["const factory = () => value => value;", "factory()(process.env.PRIVATE_TOKEN)", true],
  [
    "const Promise = { resolve: () => 'public' };",
    "await Promise.resolve(process.env.PRIVATE_TOKEN)",
    false,
  ],
  [
    "const Promise = { reject: value => value };",
    "await Promise.reject(process.env.PRIVATE_TOKEN)",
    true,
  ],
])("traces invoked values: %s %s", async (setup, value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: { "vite.config.ts": `${setup}\nexport default { define: { __CONFIG__: ${value} } }` },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["{ define: { __CONFIG__: process.env.PRIVATE_TOKEN } }", "{}", true],
  ["{}", "{ define: { __CONFIG__: process.env.PRIVATE_TOKEN } }", true],
  [
    "{ define: { __CONFIG__: process.env.PRIVATE_TOKEN } }",
    "{ define: { __CONFIG__: 'public' } }",
    false,
  ],
])("reads effective merged config: %s %s", async (base, override, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { mergeConfig as merge } from 'vite'; export default merge(${base}, ${override})`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["const factory = () => () => 'public'", "factory()(process.env.PRIVATE_TOKEN)", false],
  [
    "const factory = () => flag ? (value = process.env.PRIVATE_TOKEN) => value : () => 'public'",
    "factory()()",
    true,
  ],
  [
    "const factory = () => () => (value = process.env.PRIVATE_TOKEN) => value",
    "factory()()()",
    true,
  ],
  [
    "const read = ({ nested: { value: renamed = process.env.PRIVATE_TOKEN } } = { nested: {} }) => renamed",
    "read()",
    true,
  ],
  [
    "const read = ({ value = process.env.PRIVATE_TOKEN }) => value",
    "read({ value: 'public' })",
    false,
  ],
  [
    "const input = { value: process.env.PRIVATE_TOKEN }; const read = ({ value }) => value",
    "read(input)",
    true,
  ],
])("preserves call binding semantics: %s %s", async (setup, value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: { "vite.config.ts": `${setup}; export default { define: { __CONFIG__: ${value} } }` },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test("applies a reused config at each merge position", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { mergeConfig } from 'vite';
const base = { define: { __CONFIG__: 'public' } };
const override = { define: { __CONFIG__: process.env.PRIVATE_TOKEN } };
export default mergeConfig(base, mergeConfig(override, base));`,
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("checks runtime object replacements in merged configs", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noRuntimeObjectDefine,
    files: {
      "vite.config.ts": `import { mergeConfig } from 'vite'; export default mergeConfig({}, { define: { VALUE: {} } });`,
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["mergeConfig(flag ? secret : publicConfig, {})", true],
  ["mergeConfig({}, flag ? secret : publicConfig)", true],
  ["mergeConfig(flag ? secret : publicConfig, publicConfig)", false],
  ["mergeConfig(secret, flag ? publicConfig : {})", true],
  ["mergeConfig(flag ? secret : publicConfig, flag ? {} : publicConfig)", true],
])("preserves alternatives in %s", async (config, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { mergeConfig } from 'vite';
const secret = { define: { VALUE: process.env.PRIVATE_TOKEN } };
const publicConfig = { define: { VALUE: 'public' } };
export default ${config};`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each(["const defineConfig = () => ({})", "import { defineConfig } from 'unrelated'"])(
  "does not unwrap an unrelated defineConfig: %s",
  async (setup) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `${setup}; export default defineConfig({ define: { PRIVATE_TOKEN: {} } });`,
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test(`resolves static template define keys for ${rule.meta.id}`, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: {
        "vite.config.ts": "const key = `PRIVATE_TOKEN`; export default { define: { [key]: {} } };",
      },
    });
    expect(result.diagnostics).toHaveLength(1);
  });
}

test.each([
  ["get value() { return process.env.PRIVATE_TOKEN }", true],
  ["value() { return process.env.PRIVATE_TOKEN }", false],
  ["get value() { return 'public' }", false],
])("traces serialized accessors: %s", async (property, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const holder = { ${property} }; export default { define: { VALUE: JSON.stringify(holder) } };`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["{ value: 'public', ...secret }", true],
  ["{ ...secret, value: 'public' }", false],
  ["{ ...{ ...secret } }", true],
  ["{ ...secret, ...{ value: 'public' } }", false],
])("preserves destructured spread precedence: %s", async (argument, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const secret = { value: process.env.PRIVATE_TOKEN }; const read = ({ value }) => value; export default { define: { VALUE: read(${argument}) } };`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});
