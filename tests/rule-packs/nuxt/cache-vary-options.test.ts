import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noPersonalizedCachedHandler } from "../../../src/rule-packs/nuxt/rules/nuxthub.ts";

async function diagnose(body: string, options = "") {
  return runRuleFixture({
    rule: noPersonalizedCachedHandler,
    framework: "nuxt",
    files: {
      "server/api/profile.ts": `export default cachedEventHandler(async event => { const user = event.context.user; ${body} }${options ? `, ${options}` : ""})`,
    },
  });
}

test.each([
  "return { name: user.name }",
  "return { group: user.group }",
  "return { headers: user.headers }",
  "const varies = []; return user",
  "const getKey = () => user.id; return user",
  "// headers varies getKey\nreturn user",
])("callback source cannot supply cache vary options: %s", async (body) => {
  expect((await diagnose(body)).diagnostics.map((d) => d.ruleId)).toEqual([
    noPersonalizedCachedHandler.meta.id,
  ]);
});

test.each([
  '{ name: "profile" }',
  '{ group: "profiles" }',
  '{ headers: ["cookie"] }',
  '{ nested: { varies: ["cookie"] } }',
  "{ varies: [] }",
  "{ varies: [null, false, ''] }",
  "{ getKey: null }",
  "{ getKey: undefined }",
  "{ getKey: false }",
  "{ getKey: {} }",
  "{ getKey: [] }",
  "{ get getKey() { return null } }",
  "{ set getKey(value) {} }",
  "{ getKey: profileKey, ...{ get getKey() { return null } } }",
  '{ varies: ["cookie"], ...{ set varies(value) {} } }',
  "{ varies: {} }",
  "{ varies: () => [] }",
  "{ varies: [{}] }",
  "{ varies: [``] }",
  "{ varies: [...[]] }",
  '{ varies: ["cookie"], ...{ varies: [] } }',
  "{ getKey: profileKey, ...{ getKey: null } }",
  '{ varies: ["cookie"], ...unknownOptions }',
  '{ varies: ["cookie"], [optionName]: [] }',
  "{ allowCookies: [] }",
  '{ varies: ["cookie"], allowCookies: [] }',
  '{ allowCookies: ["session"], ...{ allowCookies: undefined }, varies: [] }',
  '{ allowCookies: ["session"], allowCookies: undefined }',
  '{ varies: ["cookie"], ...{ varies: undefined } }',
  "{ getKey: profileKey, ...{ getKey: undefined } }",
  "{ allowAuthorization: true, ...{ allowAuthorization: undefined } }",
  '{ allowCookies: [""] }',
  '{ allowCookies: ["session", 1] }',
  "{ allowAuthorization: false }",
])("only effective top-level vary options satisfy the rule: %s", async (options) => {
  expect((await diagnose("return user", options)).diagnostics.map((d) => d.ruleId)).toEqual([
    noPersonalizedCachedHandler.meta.id,
  ]);
});

test.each([
  '{ varies: ["cookie"] }',
  '{ "varies": ["authorization"] }',
  '{ ["varies"]: ["x-tenant"] }',
  "{ varies: varyingHeaders }",
  "{ getKey: event => event.context.user.id }",
  "{ getKey(event) { return event.context.user.id } }",
  "{ get getKey() { return null }, ...{ getKey: profileKey } }",
  "{ getKey: profileKey }",
  "{ getKey: keys.profile }",
  "{ varies: configuredHeaders() }",
  "{ varies: [`cookie`] }",
  '{ varies: [...["cookie"]] }',
  '{ ...unknownOptions, varies: ["cookie"] }',
  '{ varies: ["cookie"], ...{ maxAge: 60 } }',
  '{ allowCookies: ["session"] }',
  '{ varies: ["cookie"], allowCookies: ["session"] }',
  '{ allowCookies: ["session"], ...{ allowCookies: undefined }, varies: ["cookie"] }',
  '{ varies: ["cookie"], allowCookies: undefined }',
  "{ allowCookies: cookieNames }",
  "{ allowAuthorization: true }",
])("preserves explicit cache vary strategies: %s", async (options) => {
  expect((await diagnose("return { name: user.name }", options)).diagnostics).toEqual([]);
});

test("cache option names do not imply personalized callback behavior", async () => {
  const result = await runRuleFixture({
    rule: noPersonalizedCachedHandler,
    framework: "nuxt",
    files: {
      "server/api/public.ts":
        'export default cachedEventHandler(() => ({ total: 3 }), { name: "users" })',
    },
  });
  expect(result.diagnostics).toEqual([]);
});
