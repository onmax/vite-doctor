import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferValidatedBody } from "../../../src/rule-packs/nitro/rules/prefer-validated-body.ts";
import { preferValidatedQuery } from "../../../src/rule-packs/nitro/rules/prefer-validated-query.ts";
import { preferValidatedRouterParams } from "../../../src/rule-packs/nitro/rules/prefer-validated-router-params.ts";

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
