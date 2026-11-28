import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferValidatedBody } from "../../../src/rule-packs/h3/rules/prefer-validated-body.ts";
import { preferValidatedQuery } from "../../../src/rule-packs/h3/rules/prefer-validated-query.ts";
import { preferValidatedRouterParams } from "../../../src/rule-packs/h3/rules/prefer-validated-router-params.ts";

const cases = [
  { rule: preferValidatedBody, read: "await readBody(event)" },
  { rule: preferValidatedQuery, read: "getQuery(event)" },
  { rule: preferValidatedRouterParams, read: "getRouterParams(event)" },
];

for (const { rule, read } of cases) {
  test.each([
    "function validateOther(input) { schema.parse(input) }; return input",
    "function unused() { schema.parse(input) }; return input",
    "const unused = (input) => schema.parse(input); return input",
    "const unused = () => schema.parse(input); return input",
    "{ const input = {}; schema.parse(input) }; return input",
    "try { throw {} } catch (input) { schema.parse(input) }; return input",
    "for (const input of values) { schema.parse(input) }; return input",
    "{ schema.parse(input); const input = {} }; return input",
    "const other = {}; schema.parse(other); return input",
    "schema.parse(input.item); return input",
    "class Unused { value = schema.parse(input) }; return input",
    "function parseSince(q) { return Number(q.since) || 0 }; return parseSince(input)",
    "const parseScope = (q) => (typeof q.scope === 'string' ? q.scope : null); return parseScope(input)",
    "return parseUnresolved(input)",
  ])(`${rule.meta.id} ignores unrelated or deferred validation: %s`, async (body) => {
    const result = await runRuleFixture({
      rule,
      framework: "nuxt",
      files: {
        "server/api/input.ts": `export default defineEventHandler(async event => { const input = ${read}; ${body} })`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    "return schema.parse(input)",
    "return validateInput(input)",
    "{ schema.safeParse(input) }; return input",
    "if (enabled) { schema.parse(input) }; return input",
    "function unrelated(input) { return input }; return schema.parse(input)",
    "{ const input = {}; use(input) }; return schema.parse(input)",
    "function parseWindow(q) { if (!q.from) throw new Error('from'); return q }; return parseWindow(input)",
    "const parseWindow = (q) => { const ms = (v) => { if (!v) throw new Error('v'); return v }; return ms(q.from) }; return parseWindow(input)",
    "const parseFlag = (q) => { if (!q.flag) return false; return q }; return parseFlag(input)",
  ])(`${rule.meta.id} preserves validation of the request binding: %s`, async (body) => {
    const result = await runRuleFixture({
      rule,
      framework: "nuxt",
      files: {
        "server/api/input.ts": `export default defineEventHandler(async event => { const input = ${read}; ${body} })`,
      },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([rule.meta.id]);
  });
}

for (const { rule, read } of cases) {
  test.each([
    ["import * as v from 'valibot'", "v.assert(v.object({}), INPUT)"],
    ["import { z } from 'zod'", "z.object({}).transform(() => false).parse(INPUT)"],
  ])(`${rule.meta.id} cautions against changing validator results: %s`, async (imports, call) => {
    for (const inline of [true, false]) {
      const result = await runRuleFixture({
        rule,
        framework: "nuxt",
        files: {
          "server/middleware/input.ts": `${imports}; export default defineEventHandler(async event => {
            ${inline ? "" : `const input = ${read};`}
            return ${call.replace("INPUT", inline ? read : "input")}
          })`,
        },
      });
      expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([rule.meta.id]);
      expect(result.diagnostics[0]?.suggestion).toContain("keep the read and validation separate");
      expect(result.diagnostics[0]?.suggestion).toContain("false means validation failed");
      expect(result.diagnostics[0]?.suggestion).toContain(
        "returns raw input when the callback returns true, null, or undefined",
      );
      expect(result.diagnostics[0]?.suggestion).toBe(rule.meta.recommendedReplacement);
    }
  });

  test.each([
    `return UserSchema.parse(${read})`,
    `return bodySchema.safeParse(${read})`,
    `return v.parse(Schema, ${read})`,
    `return validateInput(${read})`,
    `return schema.parse((${read}) as unknown)`,
    `return schema.parse(<unknown>(${read}))`,
  ])(`${rule.meta.id} reports validation of the read itself: %s`, async (body) => {
    const result = await runRuleFixture({
      rule,
      framework: "nuxt",
      files: {
        "server/api/input.ts": `export default defineEventHandler(async event => { ${body} })`,
      },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([rule.meta.id]);
  });

  test.each([
    `return JSON.parse(${read})`,
    `return globalThis.JSON.parse(${read})`,
    `return UserSchema.parse({}, ${read})`,
    `return v.parse(${read}, {})`,
    `return normalize(${read})`,
    `return UserSchema.parse({ ...${read}, id: 1 })`,
    `const input = ${read}; return JSON.parse(input)`,
  ])(`${rule.meta.id} ignores reads that are not validated directly: %s`, async (body) => {
    const result = await runRuleFixture({
      rule,
      framework: "nuxt",
      files: {
        "server/api/input.ts": `export default defineEventHandler(async event => { ${body} })`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });
}

test.each([
  ["import { parse } from 'node:path'", "parse(await readBody<string>(event))"],
  ["import * as schema from 'path'", "schema.parse(await readBody<string>(event))"],
  [
    "import assert from 'node:assert/strict'",
    "assert(event.context.ready, await readBody<string>(event))",
  ],
])("H30007 ignores non-validation calls: %s", async (imports, expression) => {
  const result = await runRuleFixture({
    rule: preferValidatedBody,
    framework: "nuxt",
    files: {
      "server/api/input.ts": `${imports}; export default defineEventHandler(async event => ${expression})`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["import * as validation from 'valibot'", "validation.parse(Schema, getQuery(event))"],
  ["import { parse as decode } from 'valibot'", "decode(Schema, getQuery(event))"],
  [
    "import * as schema from 'node:path'",
    "{ const schema = makeSchema(); return schema.parse(getQuery(event)) }",
  ],
])("H30008 recognizes validation at the resolved call site: %s", async (imports, body) => {
  const result = await runRuleFixture({
    rule: preferValidatedQuery,
    framework: "nuxt",
    files: {
      "server/api/input.ts": `${imports}; export default defineEventHandler(event => ${body})`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    preferValidatedQuery.meta.id,
  ]);
});

test.each([
  ["return StringSchema.parse(await readBody(event, { strict: false }))", false],
  [
    "const input = await readBody(event, { strict: false }); return StringSchema.parse(input)",
    false,
  ],
  ["return StringSchema.parse(await readBody(event, options))", false],
  ["return StringSchema.parse(await readBody(event, { strict: true }))", true],
])("H30007 checks explicit body parsing options: %s", async (body, reports) => {
  const result = await runRuleFixture({
    rule: preferValidatedBody,
    framework: "nuxt",
    files: {
      "server/api/input.ts": `export default defineEventHandler(async event => { ${body} })`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(
    reports ? [preferValidatedBody.meta.id] : [],
  );
});

test.each([
  ["import { z } from 'zod'", "", "z.object({ page: z.string() }).parse(INPUT)", true],
  [
    "import * as z from 'zod'",
    "const filter = z.object({ page: z.string() }).strict()",
    "filter.safeParse(INPUT)",
    true,
  ],
  ["import { object, string } from 'zod'", "", "object({ page: string() }).parse(INPUT)", true],
  ["import * as v from 'valibot'", "const filter = v.object({})", "v.assert(filter, INPUT)", true],
  [
    "import { assert as verify, object } from 'valibot'",
    "const filter = object({})",
    "verify(filter, INPUT)",
    true,
  ],
  [
    "import * as zm from 'zod/mini'",
    "const filter = zm.object({})",
    "zm.parse(filter, INPUT)",
    true,
  ],
  [
    "import { parse as decode, object } from 'zod/mini'",
    "const filter = object({})",
    "decode(filter, INPUT)",
    true,
  ],
  ["import * as z from 'zod'", "", "z.object({}).parse({}, INPUT)", false],
  ["import * as v from 'valibot'", "", "v.assert(INPUT, {})", false],
  ["import { check } from 'valibot'", "", "check(INPUT)", false],
  ["import * as zm from 'zod/mini'", "", "zm.parse(INPUT, {})", false],
  ["import { object } from './other'", "", "object({}).parse(INPUT)", false],
  ["import { z } from 'zod'", "const z = other", "z.object({}).parse(INPUT)", false],
])(
  "H30008 recognizes validator signatures: %s / %s / %s",
  async (imports, setup, call, reports) => {
    for (const inline of [true, false]) {
      const read = "getQuery(event)";
      const result = await runRuleFixture({
        rule: preferValidatedQuery,
        framework: "nuxt",
        files: {
          "server/api/input.ts": `${imports}; export default defineEventHandler(event => {
          ${setup}; ${inline ? "" : `const input = ${read};`}
          return ${call.replace("INPUT", inline ? read : "input")}
        })`,
        },
      });
      expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(
        reports ? [preferValidatedQuery.meta.id] : [],
      );
    }
  },
);
