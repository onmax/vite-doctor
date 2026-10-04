import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferCachedEventHandler } from "../../../src/rule-packs/nuxt/rules/nuxthub.ts";

async function diagnose(file: string, body: string) {
  return runRuleFixture({
    rule: preferCachedEventHandler,
    framework: "nuxt",
    files: { [file]: `export default defineEventHandler(async event => { ${body} })` },
  });
}

test.each(["post", "put", "patch", "delete", "options", "connect", "trace"])(
  "does not recommend response caching for %s handlers",
  async (method) => {
    const result = await diagnose(
      `server/api/action.${method}.ts`,
      'return await $fetch("/upstream")',
    );
    expect(result.diagnostics).toEqual([]);
  },
);

test.each(["post.dev.ts", "patch.prod.mjs", "delete.prerender.cts"])(
  "respects method suffixes before environment and language extensions: %s",
  async (suffix) => {
    const result = await diagnose(
      `server/api/action.${suffix}`,
      'return await $fetch("/upstream")',
    );
    expect(result.diagnostics).toEqual([]);
  },
);

test.each([
  "readBody",
  "readValidatedBody",
  "readRawBody",
  "readMultipartFormData",
  "readFormData",
])("does not recommend caching handlers that consume request bodies through %s", async (read) => {
  const result = await diagnose(
    "server/api/action.ts",
    `const input = await ${read}(event); return await $fetch("/upstream", { body: input })`,
  );
  expect(result.diagnostics).toEqual([]);
});

test("reading a body alone is not evidence of expensive public work", async () => {
  const result = await diagnose(
    "server/api/action.ts",
    "const input = await readBody(event); return database.insert(input)",
  );
  expect(result.diagnostics).toEqual([]);
});

test.each(["get.ts", "head.ts", "get.dev.ts", "get.prod.mjs"])(
  "preserves public read-handler advice for %s",
  async (suffix) => {
    const result = await diagnose(
      `server/api/catalog.${suffix}`,
      'return await $fetch("/catalog")',
    );
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([preferCachedEventHandler.meta.id]);
  },
);

test("preserves public read-handler advice without a method suffix", async () => {
  const result = await diagnose("server/api/catalog.ts", 'return await $fetch("/catalog")');
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([preferCachedEventHandler.meta.id]);
});
