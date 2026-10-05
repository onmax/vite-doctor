import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import {
  noPersonalizedCachedHandler,
  preferCachedEventHandler,
} from "../../../src/rule-packs/nuxt/rules/nuxthub.ts";

for (const name of ["cachedEventHandler", "defineCachedEventHandler"]) {
  test.each([
    "{ shouldBypassCache: () => true }",
    "{ shouldBypassCache() { return true } }",
    "{ getKey: event => event.context.user.id }",
    "{ 'varies': ['cookie'] }",
  ])(`${name} respects explicit cache controls: %s`, async (options) => {
    const result = await runRuleFixture({
      rule: noPersonalizedCachedHandler,
      framework: "nuxt",
      files: {
        "server/api/profile.get.ts": `export default ${name}(event => event.context.user, ${options})`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    "{ varies: [] }",
    "{ varies: [''] }",
    "{ varies: false }",
    "{ varies: undefined }",
    "{ varies: ['cookie'], varies: [] }",
    "{ varies: ['cookie'], ...otherOptions }",
    "{ shouldBypassCache: () => false }",
    "{ shouldBypassCache: event => Boolean(event.context.user) }",
    "{ getKey: undefined }",
    "{ name: 'profile', group: 'api', headers: ['cookie'] }",
    "{ note: 'varies getKey shouldBypassCache' }",
    "{ /* varies: ['cookie'] */ maxAge: 60 }",
  ])(`${name} reports ineffective or mentioned cache controls: %s`, async (options) => {
    const result = await runRuleFixture({
      rule: noPersonalizedCachedHandler,
      framework: "nuxt",
      files: {
        "server/api/profile.get.ts": `export default ${name}(event => event.context.user, ${options})`,
      },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([noPersonalizedCachedHandler.meta.id]);
  });

  test(`${name} receives personalized response diagnostics`, async () => {
    const result = await runRuleFixture({
      rule: noPersonalizedCachedHandler,
      framework: "nuxt",
      files: { "server/api/profile.get.ts": `export default ${name}(event => event.context.user)` },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([noPersonalizedCachedHandler.meta.id]);
  });

  test(`${name} preserves explicit varies controls`, async () => {
    const result = await runRuleFixture({
      rule: noPersonalizedCachedHandler,
      framework: "nuxt",
      files: {
        "server/api/profile.get.ts": `export default ${name}(event => event.context.user, { varies: ['cookie'] })`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test(`${name} does not receive advice to add a cache wrapper`, async () => {
    const result = await runRuleFixture({
      rule: preferCachedEventHandler,
      framework: "nuxt",
      files: {
        "server/api/catalog.get.ts": `export default ${name}(async () => await $fetch('/catalog'))`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });
}

test.each([
  "// cachedEventHandler is an available wrapper",
  "/* cachedEventHandler is an available wrapper */",
  'const example = "cachedEventHandler"',
  "const cachedEventHandler = importedWrapper",
])("non-call mentions do not suppress cache advice: %s", async (prefix) => {
  const result = await runRuleFixture({
    rule: preferCachedEventHandler,
    framework: "nuxt",
    files: {
      "server/api/catalog.get.ts": `${prefix}\nexport default defineEventHandler(async () => await $fetch('/catalog'))`,
    },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([preferCachedEventHandler.meta.id]);
});

test("unrelated wrapper names do not imply a cached handler", async () => {
  const result = await runRuleFixture({
    rule: noPersonalizedCachedHandler,
    framework: "nuxt",
    files: {
      "server/api/profile.get.ts":
        "export default cachedEventHandlerFactory(event => event.context.user)",
    },
  });
  expect(result.diagnostics).toEqual([]);
});
