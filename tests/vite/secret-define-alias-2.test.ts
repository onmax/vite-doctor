import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noRuntimeObjectDefine, noSecretDefine } from "../../src/rule-packs/vite/rules/define.ts";

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
