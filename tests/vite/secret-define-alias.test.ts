import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noRuntimeObjectDefine, noSecretDefine } from "../../src/rule-packs/vite/rules/define.ts";

test("binds the containing object when reading a define getter", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const config = {
  definitions: { VALUE: process.env.PRIVATE_TOKEN },
  get define() { return this.definitions }
}; export default config`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(noSecretDefine.meta.id);
});

test("ignores array writes after an unconditional helper return", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = [];
function add() { return; replacement.push(process.env.PRIVATE_TOKEN) }
add(); export default { define: { VALUE: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(false);
});

test("tracks array writes through destructured aliases", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const [replacement] = [[]];
replacement.push(process.env.PRIVATE_TOKEN);
export default { define: { VALUE: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(noSecretDefine.meta.id);
});

test("binds helper arguments when recording array writes", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const values = [];
const append = value => values.push(value);
append(process.env.PRIVATE_TOKEN);
export default { define: { VALUE: JSON.stringify(values) } }`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(noSecretDefine.meta.id);
});

test("binds arguments separately for repeated helper calls", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const values = [];
const append = value => values.push(value);
append(process.env.PUBLIC_VERSION);
append(process.env.PRIVATE_TOKEN);
export default { define: { VALUE: JSON.stringify(values) } }`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(noSecretDefine.meta.id);
});

test.each([
  ["safe", "PRIVATE_TOKEN", true],
  ["process.env.PRIVATE_TOKEN", "'safe'", false],
])(
  "uses the effective object write when serializing an alias",
  async (original, replacement, expected) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `const value = { token: ${original} };
value.token = ${replacement};
export default { define: { VALUE: JSON.stringify(value) } }`,
      },
    });
    expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(
      expected,
    );
  },
);

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
  ["const key = 'PRIVATE_TOKEN'; const { [key]: replacement = '' } = process.env", true],
  ["let { PRIVATE_TOKEN: replacement } = process.env; replacement = 'public'", false],
  ["const { PRIVATE_TOKEN: other, ...replacement } = process.env", false],
  ["const key = 'PRIVATE_TOKEN'; const { [key]: replacement } = process.env", true],
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
  ["mergeConfig(flag ? secret : publicConfig, flag ? publicConfig : {})", false],
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
const flag = Math.random() > 0.5;
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

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    "import * as vite from 'vite'; export default vite.defineConfig({ define: { PRIVATE_TOKEN: {} } })",
    "import * as vite from 'vite'; export default vite.mergeConfig({}, { define: { PRIVATE_TOKEN: {} } })",
    "function makeConfig() { return { define: { PRIVATE_TOKEN: {} } } }; export default makeConfig()",
    "const makeConfig = () => ({ define: { PRIVATE_TOKEN: {} } }); export default makeConfig()",
  ])(`reads exported config helpers for ${rule.meta.id}: %s`, async (config) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": config },
    });
    expect(result.diagnostics).toHaveLength(1);
  });
}

test.each([
  ["JSON.stringify({ toJSON() { return process.env.PRIVATE_TOKEN } })", true],
  ["JSON.stringify({}, () => process.env.PRIVATE_TOKEN)", true],
  ["JSON.stringify({ toJSON: () => process.env.PRIVATE_TOKEN })", true],
  ["JSON.stringify({ toJSON() { return 'public' } })", false],
  ["JSON.stringify({}, () => 'public')", false],
  [
    "JSON.stringify({ privateValue: process.env.PRIVATE_TOKEN, toJSON() { return 'public' } })",
    false,
  ],
  [
    "JSON.stringify({ toJSON() { return process.env.PRIVATE_TOKEN }, toJSON: () => 'public' })",
    false,
  ],
  ["JSON.stringify({ ...{ toJSON() { return process.env.PRIVATE_TOKEN } } })", true],
])("traces serialization hooks: %s", async (value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `export default { define: { VALUE: ${value} } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ['JSON.stringify({}, ["PRIVATE_TOKEN"])', false],
  ['JSON.stringify({}, "PRIVATE_TOKEN")', false],
  ["JSON.stringify({}, { value: process.env.PRIVATE_TOKEN })", false],
  [
    'JSON.stringify({ toJSON() { return { hidden: process.env.PRIVATE_TOKEN } } }, ["public"])',
    false,
  ],
  ['JSON.stringify({ public: "safe", hidden: process.env.PRIVATE_TOKEN }, ["public"])', false],
  ['JSON.stringify({ public: process.env.PRIVATE_TOKEN }, ["public"])', true],
  ['JSON.stringify({ nested: { hidden: process.env.PRIVATE_TOKEN } }, ["nested"])', false],
  ["JSON.stringify({ toJSON(key = process.env.PRIVATE_TOKEN) { return key } })", false],
  ["JSON.stringify({ nested: { toJSON(key = process.env.PRIVATE_TOKEN) { return key } } })", false],
  ["JSON.stringify({ PRIVATE_TOKEN: { toJSON(key) { return key } } })", true],
  ["JSON.stringify({ toJSON(key) { return key } })", false],
])("preserves JSON serialization arguments: %s", async (value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `export default { define: { VALUE: ${value} } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["(...values) => values[0]", "process.env.PRIVATE_TOKEN", true],
  ["(...values) => values[1]", 'process.env.PRIVATE_TOKEN, "public"', false],
  ["(first, ...values) => values[0]", '"public", process.env.PRIVATE_TOKEN', true],
  ["(...values) => values", '"public", process.env.PRIVATE_TOKEN', true],
])("binds rest arguments: %s", async (helper, args, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const read = ${helper}; export default { define: { VALUE: JSON.stringify(read(${args})) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    ["const make = config => config; export default make({ define: { PRIVATE_TOKEN: {} } })", true],
    [
      "function make(config) { return config }; export default make({ define: { PRIVATE_TOKEN: {} } })",
      true,
    ],
    [
      "const make = (config = { define: { PRIVATE_TOKEN: {} } }) => config; export default make()",
      true,
    ],
    [
      "const make = (config = { define: { PRIVATE_TOKEN: {} } }) => config; export default make({})",
      false,
    ],
    [
      'const make = config => config; export default mergeConfig(make({ define: { VALUE: { nested: process.env.PRIVATE_TOKEN } } }), make({ define: { VALUE: "safe" } }))',
      false,
    ],
  ])(`binds config factory arguments for ${rule.meta.id}: %s`, async (config, expected) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: {
        "vite.config.ts": `import { mergeConfig } from 'vite'; ${config}`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  });
}

test.each(["!flag", "!!!flag", "!alias"])(
  "correlates negated config predicates: %s",
  async (predicate) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `import { mergeConfig } from 'vite'; const flag = process.env.MODE; const alias = flag;
const secret = { define: { VALUE: process.env.PRIVATE_TOKEN } }; const publicConfig = { define: { VALUE: 'public' } };
export default mergeConfig(flag ? secret : publicConfig, ${predicate} ? {} : publicConfig)`,
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each([
  [
    'JSON.stringify({ hidden: process.env.PRIVATE_TOKEN }, (key, value) => key === "hidden" ? undefined : value)',
    false,
  ],
  [
    'JSON.stringify({ visible: process.env.PRIVATE_TOKEN }, (key, value) => key === "hidden" ? undefined : value)',
    true,
  ],
  [
    'JSON.stringify({ nested: { hidden: process.env.PRIVATE_TOKEN } }, (key, value) => key === "hidden" ? undefined : value)',
    false,
  ],
  ['JSON.stringify({ hidden: process.env.PRIVATE_TOKEN }, () => "public")', false],
  ["JSON.stringify({}, () => process.env.PRIVATE_TOKEN)", true],
  ['JSON.stringify({ ...{ value: process.env.PRIVATE_TOKEN }, value: "public" })', false],
  ['JSON.stringify({ value: "public", ...{ value: process.env.PRIVATE_TOKEN } })', true],
  ['JSON.stringify({ [name]: process.env.PRIVATE_TOKEN }, ["public"])', true],
  ['JSON.stringify({ [name]: process.env.PRIVATE_TOKEN }, ["other"])', false],
  ['JSON.stringify({ [name]: process.env.PRIVATE_TOKEN, public: "safe" })', false],
  ["JSON.stringify({ [name]: { toJSON(key) { return key } } })", false],
  ["JSON.stringify({ [secretName]: { toJSON(key) { return key } } })", true],
  ['JSON.stringify(read("safe", process.env.PRIVATE_TOKEN))', false],
])("preserves reviewed serialization semantics: %s", async (value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const name = "public"; const secretName = "PRIVATE_TOKEN"; const read = (...values) => values["01"]; export default { define: { VALUE: ${value} } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    "const make = ({ config }) => config; export default make({ config: { define: { PRIVATE_TOKEN: {} } } })",
    "const make = ({ config: renamed }) => renamed; export default make({ config: { define: { PRIVATE_TOKEN: {} } } })",
    "const make = ([config]) => config; export default make([{ define: { PRIVATE_TOKEN: {} } }])",
    "const make = (config = { define: { PRIVATE_TOKEN: {} } }) => config; export default make(void 0)",
    "const missing = void 0; const make = (config = { define: { PRIVATE_TOKEN: {} } }) => config; export default make(missing)",
    "const make = ({ config = { define: { PRIVATE_TOKEN: {} } } }) => config; export default make({})",
  ])(`resolves reviewed factory bindings for ${rule.meta.id}: %s`, async (config) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": config },
    });
    expect(result.diagnostics).toHaveLength(1);
  });
}

test.each([
  [
    "const env = process.env; const { PRIVATE_TOKEN: replacement } = env;",
    "JSON.stringify(replacement)",
    true,
  ],
  [
    "const env = import.meta.env; const alias = env; const { PRIVATE_TOKEN: replacement } = alias;",
    "JSON.stringify(replacement)",
    true,
  ],
  [
    "const env = process.env; const { PUBLIC_VALUE: replacement } = env;",
    "JSON.stringify(replacement)",
    false,
  ],
  ["const JSON = { stringify: () => process.env.PRIVATE_TOKEN };", "JSON.stringify({})", true],
  [
    'const JSON = { stringify: () => "public" };',
    "JSON.stringify(process.env.PRIVATE_TOKEN)",
    false,
  ],
  ["", 'JSON.stringify(true ? "public" : process.env.PRIVATE_TOKEN)', false],
  ["", 'JSON.stringify(false ? process.env.PRIVATE_TOKEN : "public")', false],
  ["const enabled = true;", 'JSON.stringify(enabled ? process.env.PRIVATE_TOKEN : "public")', true],
  ["", "JSON.stringify({ toJSON() { return () => {} } }, () => process.env.PRIVATE_TOKEN)", true],
  ["", "JSON.stringify(() => {}, () => process.env.PRIVATE_TOKEN)", true],
  ["", "JSON.stringify({ toJSON() { return () => process.env.PRIVATE_TOKEN } })", false],
  [
    "",
    "JSON.stringify({ toJSON() { return () => process.env.PRIVATE_TOKEN } }, (key, value) => value)",
    false,
  ],
])("handles reviewed secret flow: %s %s", async (setup, value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: { "vite.config.ts": `${setup} export default { define: { VALUE: ${value} } }` },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["settings.public", false],
  ['settings["public"]', false],
  ["settings[key]", false],
  ["settings.token", true],
  ["values[1]", false],
  ["values[0]", true],
  ["nested.settings.public", false],
  ["overwritten.token", false],
])("traces only the selected static member: %s", async (value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const key = "public";
const settings = { token: process.env.PRIVATE_TOKEN, public: "safe" };
const values = [process.env.PRIVATE_TOKEN, "safe"];
const nested = { settings };
const overwritten = { ...settings, token: "safe" };
export default { define: { VALUE: JSON.stringify(${value}) } };`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each(["null", "undefined", "void 0", "missing"])(
  "preserves a secret define value beneath a nullish merge override: %s",
  async (value) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `import { mergeConfig } from "vite";
const missing = undefined;
export default mergeConfig({ define: { VALUE: process.env.PRIVATE_TOKEN } }, { define: { VALUE: ${value} } });`,
      },
    });
    expect(result.diagnostics).toHaveLength(1);
  },
);

test.each(["false", "0", '""', '"safe"'])(
  "applies non-nullish merge overrides: %s",
  async (value) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `import { mergeConfig } from "vite";
export default mergeConfig({ define: { VALUE: process.env.PRIVATE_TOKEN } }, { define: { VALUE: ${value} } });`,
      },
    });
    expect(result.diagnostics).toHaveLength(0);
  },
);

test.each([
  ["const settings = { value: process.env.PRIVATE_TOKEN };", "settings.missing", false],
  ["const values = [process.env.PRIVATE_TOKEN];", "values[1]", false],
  ["const values = [, process.env.PRIVATE_TOKEN];", "values[0]", false],
  [
    "const holder = { value: process.env.PRIVATE_TOKEN, read() { return this.value } };",
    "holder.read()",
    true,
  ],
  [
    'const holder = { value: "public", other: process.env.PRIVATE_TOKEN, read() { return this.value } };',
    "holder.read()",
    false,
  ],
  ["", "{ get toJSON() { return () => process.env.PRIVATE_TOKEN } }", true],
  ["", '{ get toJSON() { return () => "public" } }', false],
  ["const replacement = process.env.PRIVATE_TOKEN;", '"public" || replacement', false],
  ["const replacement = process.env.PRIVATE_TOKEN;", "false && replacement", false],
  ["const replacement = process.env.PRIVATE_TOKEN;", '"public" ?? replacement', false],
  ["const replacement = process.env.PRIVATE_TOKEN;", "null ?? replacement", true],
  ["const replacement = process.env.PRIVATE_TOKEN;", "true && replacement", true],
  ["const replacement = process.env.PRIVATE_TOKEN;", '"" || replacement', true],
])("resolves reviewed value semantics: %s %s", async (setup, value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${setup} export default { define: { VALUE: JSON.stringify(${value}) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each(["[key]", "[...keys]", '[...keys, "other"]'])(
  "resolves JSON property list %s",
  async (list) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `const key = "value"; const keys = [key]; export default { define: { VALUE: JSON.stringify({ value: process.env.PRIVATE_TOKEN }, ${list}) } }`,
      },
    });
    expect(result.diagnostics).toHaveLength(1);
  },
);

test.each([noSecretDefine, noRuntimeObjectDefine])(
  "reads CommonJS Vite helpers: $meta.id",
  async (rule) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: {
        "vite.config.cjs": `const { defineConfig: config, mergeConfig } = require("vite"); module.exports = config(mergeConfig({}, { define: { VALUE: { token: process.env.PRIVATE_TOKEN } } }));`,
      },
    });
    expect(result.diagnostics).toHaveLength(1);
  },
);

test.each([
  ['"PRIVATE_TOKEN"', true],
  ["`PRIVATE_TOKEN`", true],
  ['"PUBLIC_VERSION"', false],
])("resolves computed environment destructuring keys: %s", async (key, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const key = ${key}; const { [key]: replacement } = process.env;
export default { define: { VALUE: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    ["options.config", "{ config: { define: { PRIVATE_TOKEN: {} } } }", true],
    ['options["config"]', "{ config: { define: { PRIVATE_TOKEN: {} } } }", true],
    ["options[0]", "[{ define: { PRIVATE_TOKEN: {} } }]", true],
    ["options.config.nested", "{ config: { nested: { define: { PRIVATE_TOKEN: {} } } } }", true],
    ["options.config", "{ ...{ config: { define: { PRIVATE_TOKEN: {} } } }, config: {} }", false],
    ["options.missing", "{ config: { define: { PRIVATE_TOKEN: {} } } }", false],
  ])(
    `resolves config member projections for ${rule.meta.id}: %s`,
    async (projection, argument, expected) => {
      const result = await runRuleFixture({
        framework: "vite",
        rule,
        files: {
          "vite.config.ts": `const make = options => ${projection}; export default make(${argument})`,
        },
      });
      expect(result.diagnostics.length > 0).toBe(expected);
    },
  );
}

test.each([
  ["{} || process.env.PRIVATE_TOKEN", false],
  ["[] ?? process.env.PRIVATE_TOKEN", false],
  ["(() => {}) || process.env.PRIVATE_TOKEN", false],
  ["{} && process.env.PRIVATE_TOKEN", true],
  ["[] && process.env.PRIVATE_TOKEN", true],
  ["`public` || process.env.PRIVATE_TOKEN", false],
  ["`` || process.env.PRIVATE_TOKEN", true],
])("selects reachable logical values: %s", async (value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `export default { define: { VALUE: JSON.stringify(${value}) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ['return "public"; return process.env.PRIVATE_TOKEN', false],
  ['{ return "public" } return process.env.PRIVATE_TOKEN', false],
  ['if (flag) return "public"; else return "other"; return process.env.PRIVATE_TOKEN', false],
  ['if (flag) return "public"; return process.env.PRIVATE_TOKEN', true],
  ["throw new Error(); return process.env.PRIVATE_TOKEN", false],
])("ignores unreachable helper returns: %s", async (body, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const read = () => { ${body} }; export default { define: { VALUE: JSON.stringify(read()) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each(['["other"]', '["public"]'])("filters template keys with %s", async (list) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        "export default { define: { VALUE: JSON.stringify({ [`public`]: process.env.PRIVATE_TOKEN }, " +
        list +
        ") } }",
    },
  });
  expect(result.diagnostics.length > 0).toBe(list === '["public"]');
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    ["{ get config() { return { define: { PRIVATE_TOKEN: {} } } } }", true],
    ["{ get config() { return {} } }", false],
    ["{ config: {}, ...(flag ? { config: { define: { PRIVATE_TOKEN: {} } } } : {}) }", true],
    ["{ config: { define: { PRIVATE_TOKEN: {} } }, ...(flag ? { config: {} } : {}) }", true],
    ["{ ...(flag ? { config: { define: { PRIVATE_TOKEN: {} } } } : {}), config: {} }", false],
    ["{ config: { define: { PRIVATE_TOKEN: {} } }, ...runtimeOptions }", true],
  ])(
    `projects getters and unresolved spreads for ${rule.meta.id}: %s`,
    async (argument, expected) => {
      const result = await runRuleFixture({
        framework: "vite",
        rule,
        files: {
          "vite.config.ts": `const make = options => options.config; export default make(${argument})`,
        },
      });
      expect(result.diagnostics.length > 0).toBe(expected);
    },
  );
}

test.each([
  ['try { return process.env.PRIVATE_TOKEN } finally { return "public" }', false],
  ["try { return process.env.PRIVATE_TOKEN } finally { throw new Error() }", false],
  ["try { return process.env.PRIVATE_TOKEN } finally { const done = true }", true],
  [
    'try { throw new Error() } catch { return process.env.PRIVATE_TOKEN } finally { return "public" }',
    false,
  ],
  ['try { return "public" } finally { return process.env.PRIVATE_TOKEN }', true],
])("respects finally completion: %s", async (body, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const read = () => { ${body} }; export default { define: { VALUE: JSON.stringify(read()) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([noSecretDefine, noRuntimeObjectDefine])(
  "recognizes Vitest config helpers for $meta.id",
  async (rule) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: {
        "vitest.config.ts": `import { defineConfig, mergeConfig } from 'vitest/config'; export default defineConfig(mergeConfig({}, { define: { VALUE: { value: process.env.PRIVATE_TOKEN } } }))`,
      },
    });
    expect(result.diagnostics).toHaveLength(1);
  },
);

test.each([
  'const undefined = "public"; const read = (value = process.env.PRIVATE_TOKEN) => value; export default { define: { VALUE: JSON.stringify(read(undefined)) } }',
  'const undefined = "public"; const config = (value = process.env.PRIVATE_TOKEN) => ({ define: { VALUE: value } }); export default config(undefined)',
])("respects shadowed undefined arguments: %s", async (source) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: { "vite.config.ts": source },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ["{ token: process.env.PRIVATE_TOKEN }", '{ public: "safe" }', true],
  ["{ value: process.env.PRIVATE_TOKEN }", '{ value: "safe" }', false],
  ["{ nested: { value: process.env.PRIVATE_TOKEN } }", '{ nested: { public: "safe" } }', true],
  ["{ nested: { value: process.env.PRIVATE_TOKEN } }", '{ nested: { value: "safe" } }', false],
  ["{ value: { nested: process.env.PRIVATE_TOKEN }, value: {} }", '{ public: "safe" }', false],
  ["{}", "{ value: { nested: process.env.PRIVATE_TOKEN }, value: {} }", false],
  ["{ value: process.env.PRIVATE_TOKEN }", "{ value: null }", true],
  ["[process.env.PRIVATE_TOKEN]", '["safe"]', true],
  ["[process.env.PRIVATE_TOKEN]", '"safe"', true],
  ["{ value: process.env.PRIVATE_TOKEN }", '"safe"', false],
])("traces recursively merged define values: %s + %s", async (base, override, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { mergeConfig } from 'vite'; export default mergeConfig({ define: { VALUE: ${base} } }, { define: { VALUE: ${override} } })`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["flag && { define: { PRIVATE_TOKEN: {} } }", true],
  ["flag ? { define: { PRIVATE_TOKEN: {} } } : {}", true],
  ["flag || { define: { PRIVATE_TOKEN: {} } }", true],
  ["flag ?? { define: { PRIVATE_TOKEN: {} } }", true],
  ["null ?? { define: { PRIVATE_TOKEN: {} } }", true],
  ["false ?? { define: { PRIVATE_TOKEN: {} } }", false],
  ["false && { define: { PRIVATE_TOKEN: {} } }", false],
  ["true ? {} : { define: { PRIVATE_TOKEN: {} } }", false],
])("reads conditional config spreads: %s", async (spread, expected) => {
  for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: {
        "vite.config.ts": `const flag = process.env.MODE; export default { ...(${spread}) }`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  }
});

test.each([
  ["export default (initialize(), { define: { PRIVATE_TOKEN: {} } })", true],
  ["export default { ...(flag && { define: { PRIVATE_TOKEN: {} } }), define: {} }", false],
  ["export default { define: { ...(flag && { PRIVATE_TOKEN: {} }) } }", true],
])("reads effective config values: %s", async (source, expected) => {
  for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": `const flag = process.env.MODE; ${source}` },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  }
});

test.each([
  ["null", true],
  ["undefined", true],
  ["void 0", true],
  ["process.env.OPTIONAL_OVERRIDE", true],
  ['"safe"', false],
  ['{ public: "safe" }', true],
])("reads getter overrides before merging: %s", async (value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { mergeConfig } from 'vite'; export default mergeConfig(
      { define: { VALUE: { value: { token: process.env.PRIVATE_TOKEN } } } },
      { define: { VALUE: { get value() { return ${value} } } } })`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["export default { get define() { return { PRIVATE_TOKEN: {} } } }", true, true],
  [
    "const replacement = process.env.PRIVATE_TOKEN; export default { define: { get VALUE() { return replacement } } }",
    true,
    false,
  ],
  ["export default Object.assign({}, { define: { PRIVATE_TOKEN: {} } })", true, true],
  [
    "export default Object.assign({}, { define: { PRIVATE_TOKEN: {} } }, { define: {} })",
    false,
    false,
  ],
  [
    "const Object = { assign() { return {} } }; export default Object.assign({}, { define: { PRIVATE_TOKEN: {} } })",
    false,
    false,
  ],
  [
    'const flag = process.env.MODE; export default { ...(flag ?? { define: { VALUE: process.env.PRIVATE_TOKEN } }), ...(flag ?? { define: { VALUE: "safe" } }) }',
    false,
    false,
  ],
])("reads effective accessor and composed configs: %s", async (source, secret, runtimeObject) => {
  for (const [rule, expected] of [
    [noSecretDefine, secret],
    [noRuntimeObjectDefine, runtimeObject],
  ] as const) {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": source },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  }
});

test.each([
  [
    "const source = { value: process.env.PRIVATE_TOKEN }; const { value: replacement } = source",
    true,
  ],
  ["const source = [process.env.PRIVATE_TOKEN]; const [replacement] = source", true],
  [
    "const source = { nested: [process.env.PRIVATE_TOKEN] }; const { nested: [replacement] } = source",
    true,
  ],
  [
    "const source = { value: process.env.PUBLIC_VERSION }; const { value: replacement } = source",
    false,
  ],
  ["const source = [process.env.PUBLIC_VERSION]; const [replacement] = source", false],
  [
    "const source = { value: process.env.PRIVATE_TOKEN }; const { value: first } = source; const [replacement] = [first]",
    true,
  ],
])("traces destructured local values: %s", async (declarations, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declarations}; export default { define: { VALUE: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["[`toJSON`]() { return process.env.PRIVATE_TOKEN }", true],
  ["[hook]() { return process.env.PRIVATE_TOKEN }", true],
  ["get [`toJSON`]() { return () => process.env.PRIVATE_TOKEN }", true],
  ["[`toJSON`]() { return process.env.PUBLIC_VERSION }", false],
  ["[`other`]() { return process.env.PRIVATE_TOKEN }", false],
])("recognizes static serialization hooks: %s", async (property, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        "const hook = `toJSON`; export default { define: { VALUE: JSON.stringify({ " +
        property +
        " }) } }",
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    ["(...configs) => configs[0]", "{ define: { PRIVATE_TOKEN: {} } }"],
    ["(first, ...configs) => configs[1]", "{}, {}, { define: { PRIVATE_TOKEN: {} } }"],
    ["(...[config]) => config", "{ define: { PRIVATE_TOKEN: {} } }"],
  ])(`discovers rest parameter configs for ${rule.meta.id}: %s`, async (factory, args) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: {
        "vite.config.ts": `const make = ${factory}; export default make(${args})`,
      },
    });
    expect(result.diagnostics).toHaveLength(1);
  });
}

test.each([
  ['{ public: "safe" }', true],
  ['{ value: "safe" }', false],
])(
  "preserves dynamic getter alternatives through another merge: %s",
  async (override, expected) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `import { mergeConfig } from 'vite'; export default mergeConfig(
      mergeConfig(
        { define: { VALUE: { nested: { value: process.env.PRIVATE_TOKEN } } } },
        { define: { VALUE: { get nested() { return process.env.OPTIONAL_OVERRIDE } } } },
      ),
      { define: { VALUE: { nested: ${override} } } },
    )`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  },
);

test.each([
  ["const { value: replacement = process.env.PRIVATE_TOKEN } = {}", true],
  ["const [replacement = process.env.PRIVATE_TOKEN] = []", true],
  ["const [replacement = process.env.PRIVATE_TOKEN] = [,]", true],
  [
    "const absent = undefined; const { value: replacement = process.env.PRIVATE_TOKEN } = { value: absent }",
    true,
  ],
  ["const [replacement = process.env.PRIVATE_TOKEN] = [void 0]", true],
  ["const { value: replacement = process.env.PRIVATE_TOKEN } = { value: null }", false],
  ['const [replacement = process.env.PRIVATE_TOKEN] = ["public"]', false],
  [
    'const undefined = "public"; const [replacement = process.env.PRIVATE_TOKEN] = [undefined]',
    false,
  ],
  ["const { nested: { value: replacement } = { value: process.env.PRIVATE_TOKEN } } = {}", true],
  ["const source = [...[process.env.PRIVATE_TOKEN]]; const [replacement] = source", true],
  [
    'const source = ["public"]; const [, replacement] = [...source, process.env.PRIVATE_TOKEN]',
    true,
  ],
  ['const [replacement] = [...["public"], process.env.PRIVATE_TOKEN]', false],
  ["const [replacement] = [...unknown, process.env.PRIVATE_TOKEN]", true],
  ['const [, ...replacement] = ["public", process.env.PRIVATE_TOKEN]', true],
  ['const [, ...replacement] = [process.env.PRIVATE_TOKEN, "public"]', false],
])("projects effective destructuring values: %s", async (declarations, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declarations}; export default { define: { VALUE: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    [
      "vite.config.ts",
      "const options = [{ define: { PRIVATE_TOKEN: {} } }]; const make = config => config; export default make(...options)",
    ],
    [
      "vite.config.ts",
      "const options = [{ define: { PRIVATE_TOKEN: {} } }]; const make = (...configs) => configs[1]; export default make({}, ...[...options])",
    ],
    ["vite.config.cts", "export = { define: { PRIVATE_TOKEN: {} } }"],
  ])("reads effective factory arguments and exports: %s %s", async (file, source) => {
    const result = await runRuleFixture({ framework: "vite", rule, files: { [file]: source } });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
}

test.each([
  ["process.env.OPTIONAL_OVERRIDE", true],
  ['"public"', false],
  ["null", true],
  ["undefined", true],
])("preserves runtime-nullish merge bases: %s", async (override, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { mergeConfig } from 'vite'; export default mergeConfig({ define: { VALUE: process.env.PRIVATE_TOKEN } }, { define: { VALUE: ${override} } })`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["get value() { return process.env.PRIVATE_TOKEN }", true],
  ['get value() { return "public" }', false],
  ["set value(input) { consume(process.env.PRIVATE_TOKEN) }", false],
])("projects getter-backed destructuring: %s", async (property, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const source = { ${property} }; const { value: replacement } = source; export default { define: { VALUE: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    [
      "const make = ({ ...config }) => config; export default make({ define: { PRIVATE_TOKEN: {} } })",
      true,
    ],
    [
      "const make = ({ ignored, ...config }) => config; export default make({ ignored: true, define: { PRIVATE_TOKEN: {} } })",
      true,
    ],
    [
      "const make = ({ define, ...config }) => config; export default make({ define: { PRIVATE_TOKEN: {} } })",
      false,
    ],
    [
      "const factory = { config: { define: { PRIVATE_TOKEN: {} } }, make() { return this.config } }; export default factory.make()",
      true,
    ],
    [
      "const factory = { config: { define: { PRIVATE_TOKEN: {} } }, make() { return this.config } }; const make = factory.make; export default make()",
      false,
    ],
  ])("projects factory bindings for " + rule.meta.id + ": %s", async (source, expected) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": source },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  });
}

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    [
      'const make = ({ ["de" + "fine"]: ignored, ...config }) => config; export default make({ define: { PRIVATE_TOKEN: {} } })',
      false,
    ],
    [
      "const make = ({ [unknownKey]: ignored, ...config }) => config; export default make({ define: { PRIVATE_TOKEN: {} } })",
      false,
    ],
    [
      "const make = ({ other: ignored, ...config }) => config; export default make({ other: true, define: { PRIVATE_TOKEN: {} } })",
      true,
    ],
    [
      "const factory = { config: { define: { PRIVATE_TOKEN: {} } }, make(value = this.config) { return value } }; export default factory.make()",
      true,
    ],
    [
      "const factory = { config: { define: { PRIVATE_TOKEN: {} } }, make(value = this.config) { return value } }; const make = factory.make; export default make()",
      false,
    ],
  ])(
    "respects reviewed config projections for " + rule.meta.id + ": %s",
    async (source, expected) => {
      const result = await runRuleFixture({
        framework: "vite",
        rule,
        files: { "vite.config.ts": source },
      });
      expect(result.diagnostics.length > 0).toBe(expected);
    },
  );
}

test.each([
  [
    "const process = { env: { VALUE: {} } }; export default { define: { VALUE: process.env.VALUE } }",
    true,
  ],
  ["export default { define: { VALUE: process.env.VALUE } }", false],
  [
    'import process from "node:process"; export default { define: { VALUE: process.env.VALUE } }',
    false,
  ],
])("checks the environment receiver binding: %s", async (source, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noRuntimeObjectDefine,
    files: { "vite.config.ts": source },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["get value() {}", true],
  ["get value() { while (true) {} }", false],
  ["get value() { for (;;) {} }", false],
  ["get value() { do {} while (true) }", false],
  ["get value() { while (true) { break } }", true],
  ["get value() { return }", true],
  ['get value() { while (false) return process.env.PRIVATE_TOKEN; return "safe" }', false],
  ['get value() { if (false) return process.env.PRIVATE_TOKEN; return "safe" }', false],
  ["get value() { return process.env.PRIVATE_TOKEN }", true],
  ['get value() { return "safe" }', false],
])(
  "projects getter completion into local and parameter defaults: %s",
  async (property, expected) => {
    for (const source of [
      `const source = { ${property} }; const { value: replacement = process.env.PRIVATE_TOKEN } = source; export default { define: { VALUE: JSON.stringify(replacement) } }`,
      `const read = ({ value = process.env.PRIVATE_TOKEN }) => value; export default { define: { VALUE: JSON.stringify(read({ ${property} })) } }`,
    ]) {
      const result = await runRuleFixture({
        framework: "vite",
        rule: noSecretDefine,
        files: { "vite.config.ts": source },
      });
      expect(result.diagnostics.length > 0).toBe(expected);
    }
  },
);

test.each([
  ["process.env.PRIVATE_TOKEN", true],
  ["process.env.PUBLIC_VERSION", false],
])("follows neutral aliases returned by parameter getters: %s", async (value, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = ${value}; const read = ({ value }) => value; export default { define: { VALUE: JSON.stringify(read({ get value() { return replacement } })) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  [
    'import { default as process } from "node:process"; export default { define: { VALUE: process.env.VALUE } }',
    false,
  ],
  [
    'import { mergeConfig } from "vite"; export default mergeConfig({ define: { VALUE: "base" } }, { define: { VALUE: process.env.OPTIONAL_OVERRIDE } })',
    false,
  ],
  [
    'import { mergeConfig } from "vite"; export default mergeConfig({ define: { VALUE: {} } }, { define: { VALUE: process.env.OPTIONAL_OVERRIDE } })',
    true,
  ],
])("classifies effective primitive alternatives: %s", async (source, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noRuntimeObjectDefine,
    files: { "vite.config.ts": source },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each(["process.env.PRIVATE_TOKEN", "process.env.PUBLIC_VERSION"])(
  "resolves computed helper parameter keys: %s",
  async (value) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `const key = "value"; const read = ({ [key]: value }) => value; export default { define: { VALUE: JSON.stringify(read({ [key]: ${value} })) } }`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(value.includes("PRIVATE"));
  },
);

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    'import { defineConfig } from "vite"; const wrap = defineConfig; export default wrap({ define: { PRIVATE_TOKEN: {} } })',
    'import { mergeConfig } from "vite"; const merge = mergeConfig; export default merge({}, { define: { PRIVATE_TOKEN: {} } })',
  ])("follows imported configuration helper aliases: %s", async (source) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": source },
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
}

test.each([
  ["return", true],
  ["", true],
  ['if (process.env.MODE) return "safe"', true],
  ['return "safe"', false],
])("preserves nullish merge getter completion: %s", async (body, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { mergeConfig } from "vite"; export default mergeConfig({ define: { VALUE: { value: process.env.PRIVATE_TOKEN } } }, { define: { VALUE: { get value() { ${body} } } } })`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ['switch (process.env.MODE) { case "a": return "public"; default: return "safe" }', false],
  ['switch (process.env.MODE) { case "a": break; default: return "safe" }', true],
  ['switch (process.env.MODE) { case "a": return "public" }', true],
  [
    'switch (process.env.MODE) { case "a": case "b": return "public"; default: return "safe" }',
    false,
  ],
])("tracks switch completion in invoked helpers: %s", async (body, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `function read() { ${body}; return process.env.PRIVATE_TOKEN } export default { define: { VALUE: JSON.stringify(read()) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ["while (true) { for (;;) { break } }", false],
  ["while (true) { try { break } finally { continue } }", false],
  ['while (true) { try { break } finally { return "safe" } }', false],
  ["while (true) { try { break } finally { throw new Error() } }", false],
  ["while (true) { try { throw new Error() } catch { break } finally { continue } }", false],
  ["while (true) { try { break } finally { const done = true } }", true],
  ["while (true) { try { break } finally { if (process.env.MODE) continue } }", true],
  ["while (true) { try { continue } finally { break } }", true],
  ["while (true) { switch (process.env.MODE) { default: break } }", false],
  ["while (true) { inner: { break inner } }", false],
  ["while (true) { if (false) break }", false],
  ["while (true) { continue; break }", false],
  ["while (true) { if (process.env.MODE) break }", true],
  ["outer: while (true) { for (;;) { break outer } }", true],
])("tracks loop break ownership in getter defaults: %s", async (body, expected) => {
  for (const source of [
    `const source = { get value() { ${body} } }; const { value: replacement = process.env.PRIVATE_TOKEN } = source; export default { define: { VALUE: JSON.stringify(replacement) } }`,
    `const read = ({ value = process.env.PRIVATE_TOKEN }) => value; export default { define: { VALUE: JSON.stringify(read({ get value() { ${body} } })) } }`,
  ]) {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: { "vite.config.ts": source },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  }
});

test("does not trace unrelated secrets through an undefined merge getter", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { mergeConfig } from "vite"; const unrelated = process.env.PRIVATE_TOKEN; export default mergeConfig({ define: { VALUE: {} } }, { define: { VALUE: { get value() { if (process.env.MODE) return "safe" } } } })`,
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  ['import runtime from "node:process"; const { PRIVATE_TOKEN: replacement } = runtime.env', true],
  ['import * as runtime from "process"; const { PRIVATE_TOKEN: replacement } = runtime.env', true],
  [
    'import { default as runtime } from "node:process"; const { PUBLIC_VERSION: replacement } = runtime.env',
    false,
  ],
  [
    'const process = { env: { PRIVATE_TOKEN: "safe" } }; const { PRIVATE_TOKEN: replacement } = process.env',
    false,
  ],
  [
    'const read = ({ publicValue, ...rest }) => rest.token; const replacement = read({ publicValue: "safe", token: process.env.PRIVATE_TOKEN })',
    true,
  ],
  [
    'const read = ({ token, ...rest }) => rest; const replacement = read({ publicValue: "safe", token: process.env.PRIVATE_TOKEN })',
    false,
  ],
  [
    'const read = ({ publicValue, ...rest }) => rest; const replacement = read({ publicValue: "safe", token: process.env.PRIVATE_TOKEN })',
    true,
  ],
  [
    'const read = ({ publicValue, ...rest }) => rest.token; const values = { token: process.env.PRIVATE_TOKEN }; const replacement = read({ ...values, token: "safe" })',
    false,
  ],
  [
    "const read = (value) => value; const args = [process.env.PRIVATE_TOKEN]; const replacement = read(...args)",
    true,
  ],
  [
    'const read = (first, second) => second; const args = [process.env.PRIVATE_TOKEN]; const replacement = read(...args, "safe")',
    false,
  ],
  [
    'const read = (first, second) => second; const args = [process.env.PRIVATE_TOKEN]; const nested = ["safe", ...args]; const replacement = read(...nested)',
    true,
  ],
  [
    "const read = (first, second) => second; const args = [, process.env.PRIVATE_TOKEN]; const replacement = read(...args)",
    true,
  ],
  [
    'import runtime from "node:process"; const read = ({ publicValue, ...rest }) => rest.token; const replacement = read({ token: runtime.env.PRIVATE_TOKEN })',
    true,
  ],
  [
    "const token = process.env.PRIVATE_TOKEN; const read = ({ publicValue, ...rest }) => rest.token; const replacement = read({ token })",
    true,
  ],
  [
    'const key = "token"; const read = ({ [key]: removed, ...rest }) => rest; const replacement = read({ token: process.env.PRIVATE_TOKEN, value: "safe" })',
    false,
  ],
  [
    'const key = "token"; const read = ({ publicValue, ...rest }) => rest.token; const replacement = read({ [key]: process.env.PRIVATE_TOKEN })',
    true,
  ],
])("traces serialization helper bindings: %s", async (declarations, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declarations}; export default { define: { VALUE: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

for (const rule of [noSecretDefine, noRuntimeObjectDefine]) {
  test.each([
    "const make = ([, ...configs]) => configs[0]; export default make([{}, { define: { PRIVATE_TOKEN: {} } }])",
    "const make = ({ config }) => ({ ...config }); export default make({ get config() { return { define: { PRIVATE_TOKEN: {} } } } })",
    "const make = ({ config }) => ({ ...config }); export default make({ get config() { if (process.env.MODE) return { define: { PRIVATE_TOKEN: {} } }; return {} } })",
  ])(`projects config factory arguments for ${rule.meta.id}: %s`, async (source) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule,
      files: { "vite.config.ts": source },
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
}

test.each([
  [
    'const read = () => { switch ("a") { case "b": return process.env.PRIVATE_TOKEN; default: return "safe" } }; const replacement = read()',
    false,
  ],
  [
    'const read = () => { switch ("a") { default: return process.env.PRIVATE_TOKEN; case "a": return "safe" } }; const replacement = read()',
    false,
  ],
  [
    'const read = () => { switch ("a") { case "a": break; default: return process.env.PRIVATE_TOKEN }; return "safe" }; const replacement = read()',
    false,
  ],
  [
    'const read = () => { switch ("a") { case "a": case "b": return process.env.PRIVATE_TOKEN; default: return "safe" } }; const replacement = read()',
    true,
  ],
  [
    'const read = (value) => value; const args = [process.env.PRIVATE_TOKEN]; args[0] = "safe"; const replacement = read(...args)',
    false,
  ],
  [
    'const read = (value) => value; const args = [process.env.PRIVATE_TOKEN]; const alias = args; alias[0] = "safe"; const replacement = read(...args)',
    false,
  ],
  [
    'const read = (value) => value; const args = [process.env.PRIVATE_TOKEN]; args.fill("safe"); const replacement = read(...args)',
    false,
  ],
  [
    'const key = `publicValue`; const read = ({ [key]: removed, ...rest }) => rest.value; const replacement = read({ publicValue: "safe", value: process.env.PRIVATE_TOKEN })',
    true,
  ],
])(
  "respects effective serialization arguments and branches: %s",
  async (declarations, expected) => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `${declarations}; export default { define: { VALUE: JSON.stringify(replacement) } }`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(expected);
  },
);

test("preserves immutable arrays passed directly to JSON.stringify", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        "const replacement = [process.env.PRIVATE_TOKEN]; export default { define: { VALUE: JSON.stringify(replacement) } }",
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ['const replacement = ["safe"]; replacement[0] = process.env.PRIVATE_TOKEN', true],
  [
    "const values = [process.env.PRIVATE_TOKEN]; const replacement = []; replacement.push(...values)",
    true,
  ],
  [
    "const values = [process.env.PRIVATE_TOKEN]; const replacement = []; replacement.unshift(...values)",
    true,
  ],
  ["const replacement = []; if (false) replacement.push(process.env.PRIVATE_TOKEN)", false],
  ["const replacement = []; if (!false) replacement.push(process.env.PRIVATE_TOKEN)", true],
  [
    "const replacement = []; add(); function add() { replacement.push(process.env.PRIVATE_TOKEN) }",
    true,
  ],
  ['const replacement = [process.env.PRIVATE_TOKEN]; replacement.push("safe")', true],
  ['const replacement = [process.env.PRIVATE_TOKEN]; replacement[0] = "safe"', false],
  ['const replacement = [process.env.PRIVATE_TOKEN]; replacement.fill("safe")', false],
  ['const replacement = ["safe"]; replacement.fill(process.env.PRIVATE_TOKEN, 0, 1)', true],
  ['const replacement = [process.env.PRIVATE_TOKEN]; replacement.fill("safe", 0, 1)', false],
  ['const replacement = ["safe"]; replacement.fill(process.env.PRIVATE_TOKEN, 1, 2)', false],
  ['const replacement = ["safe"]; replacement.fill(process.env.PRIVATE_TOKEN, -1)', true],
  ['const replacement = [process.env.PRIVATE_TOKEN]; replacement.fill("safe", -1)', false],
  ['const replacement = ["safe"]; replacement.fill(process.env.PRIVATE_TOKEN, -2)', true],
  ["const replacement = []; replacement.unshift(process.env.PRIVATE_TOKEN)", true],
  ["const replacement = [process.env.PRIVATE_TOKEN]; replacement.pop()", false],
  ["const replacement = [process.env.PRIVATE_TOKEN]; replacement.shift()", false],
  ['const replacement = ["safe"]; replacement.splice(0, 1, process.env.PRIVATE_TOKEN)', true],
  ['const replacement = [process.env.PRIVATE_TOKEN]; replacement.splice(0, 1, "safe")', false],
  [
    'const replacement = [process.env.PRIVATE_TOKEN]; function clean() { replacement[0] = "safe" }',
    true,
  ],
  [
    'const replacement = ["safe"]; function taint() { replacement[0] = process.env.PRIVATE_TOKEN }',
    false,
  ],
])("tracks effective values in mutated arrays: %s", async (declarations, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declarations}; export default { define: { VALUE: JSON.stringify(replacement) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  'import { defineConfig as wrap } from "vite"; export default wrap',
  'const { defineConfig: wrap } = require("vite"); export default wrap',
  'const vite = require("vite"); export default vite.defineConfig',
])("tracks callback writes through %s", async (setup) => {
  const [declaration, invocation] = setup.split("; export default ");
  for (const [initial, write, secret] of [
    ['"safe"', "values.push(process.env.PRIVATE_TOKEN)", true],
    ["process.env.PRIVATE_TOKEN", 'values[0] = "safe"', false],
  ] as const) {
    const result = await runRuleFixture({
      framework: "vite",
      rule: noSecretDefine,
      files: {
        "vite.config.ts": `${declaration}; export default ${invocation}(() => { const values = [${initial}]; ${write}; return { define: { VALUE: JSON.stringify(values) } } })`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(secret);
  }
});

test("binds serialized getters to their object", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        'const source = { payload: process.env.PRIVATE_TOKEN, get exposed() { return this.payload } }; export default { define: { VALUE: JSON.stringify(source, ["exposed"]) } }',
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ['const [...replacement] = ["safe", process.env.PRIVATE_TOKEN]', false],
  ['const [...replacement] = ["safe", process.env.PRIVATE_TOKEN]', true],
  ['const [first, ...replacement] = ["safe", "public", process.env.PRIVATE_TOKEN]', false],
  ['const [first, ...replacement] = ["safe", "public", process.env.PRIVATE_TOKEN]', true],
])("preserves array rest indices for %s at index %s", async (declaration, secret) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `${declaration}; export default { define: { VALUE: JSON.stringify(replacement[${secret ? 1 : 0}]) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(secret);
});

test("skips returns behind static unary conditions", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        'function read() { if (!false) return "public"; return process.env.PRIVATE_TOKEN }; export default { define: { VALUE: JSON.stringify(read()) } }',
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("binds the receiver of an exported config getter", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        "const holder = { config: { define: { PRIVATE_TOKEN: process.env.PRIVATE_TOKEN } }, get current() { return this.config } }; export default holder.current",
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test("binds the receiver of a getter projected into factory parameters", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        "const make = ({ value }) => value; const source = { config: { define: { PRIVATE_TOKEN: process.env.PRIVATE_TOKEN } }, get value() { return this.config } }; export default make(source)",
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test("binds a projected getter receiver inside a nested arrow", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        "const make = ({ value }) => value; const source = { config: { define: { PRIVATE_TOKEN: process.env.PRIVATE_TOKEN } }, get value() { return (() => this.config)() } }; export default make(source)",
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["0 ?? values.push(process.env.PRIVATE_TOKEN)", false],
  ["null ?? values.push(process.env.PRIVATE_TOKEN)", true],
  ["false || values.push(process.env.PRIVATE_TOKEN)", true],
  ["({}) ?? values.push(process.env.PRIVATE_TOKEN)", false],
  ["([]) || values.push(process.env.PRIVATE_TOKEN)", false],
  ["(() => 1) && values.push(process.env.PRIVATE_TOKEN)", true],
  ["`safe` ?? values.push(process.env.PRIVATE_TOKEN)", false],
  ["`` || values.push(process.env.PRIVATE_TOKEN)", true],
])("tracks only reachable logical mutations: %s", async (expression, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const values = []; ${expression}; export default { define: { VALUE: JSON.stringify(values) } }`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test.each([
  ['const values = ["safe"]; values.push(process.env.PRIVATE_TOKEN)', true],
  ['const values = [process.env.PRIVATE_TOKEN]; values[0] = "safe"', false],
])("tracks array writes inside executed config callbacks: %s", async (body, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `import { defineConfig } from 'vite'; export default defineConfig(() => { ${body}; return { define: { VALUE: JSON.stringify(values) } } })`,
    },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});

test("tracks array writes inside invoked config factories", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        'const make = () => { const values = ["safe"]; values.push(process.env.PRIVATE_TOKEN); return { define: { VALUE: JSON.stringify(values) } } }; export default make()',
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test("binds array-rest values in serialization helpers", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts":
        'const read = ([publicValue, ...rest]) => rest[0]; export default { define: { VALUE: JSON.stringify(read(["safe", process.env.PRIVATE_TOKEN])) } }',
    },
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  [
    'const replacement = [process.env.PRIVATE_TOKEN]; const config = { define: { VALUE: JSON.stringify(replacement) } }; replacement[0] = "safe"; export default config',
    true,
  ],
  [
    'const replacement = ["safe"]; const config = { define: { VALUE: JSON.stringify(replacement) } }; replacement[0] = process.env.PRIVATE_TOKEN; export default config',
    false,
  ],
  [
    "const replacement = [process.env.PRIVATE_TOKEN]; export default { define: { VALUE: JSON.stringify(replacement, null, 2) } }",
    true,
  ],
  [
    "const replacement = [process.env.PRIVATE_TOKEN]; replacement.reverse(); export default { define: { VALUE: JSON.stringify(replacement) } }",
    true,
  ],
  [
    "const replacement = [process.env.PRIVATE_TOKEN]; replacement.forEach(() => {}); export default { define: { VALUE: JSON.stringify(replacement) } }",
    true,
  ],
])("retains array secrets at the serialization site: %s", async (source, expected) => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: { "vite.config.ts": source },
  });
  expect(result.diagnostics.length > 0).toBe(expected);
});
