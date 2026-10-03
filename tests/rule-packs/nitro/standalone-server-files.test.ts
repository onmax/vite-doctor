import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import {
  noBrowserApiInServer,
  noClientComposablesInServer,
  noEventRuntimeConfigInServer,
  noNavigateToInNitro,
  noUseNuxtAppInNitro,
  preferAssertMethod,
  preferGetRequestIp,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
  requireEventRuntimeConfigInServer,
} from "../../../src/rule-packs/nitro/rules/index.ts";

const serverRules = [
  [noBrowserApiInServer, "document.title"],
  [noClientComposablesInServer, "useRoute()"],
  [noUseNuxtAppInNitro, "useNuxtApp()"],
  [noNavigateToInNitro, "navigateTo('/login')"],
  [preferGetRequestIp, "const ip = getHeader(event, 'x-forwarded-for'); rateLimit(ip)"],
  [preferValidatedBody, "const body = await readBody(event); schema.parse(body)"],
  [preferValidatedQuery, "const query = getQuery(event); schema.parse(query)"],
  [preferValidatedRouterParams, "const params = getRouterParams(event); schema.parse(params)"],
] as const;

describe.each(["routes/index.ts", "routes/api/users.get.ts", "middleware/auth.ts"])(
  "standalone Nitro server file %s",
  (file) => {
    test.each(serverRules)("runs $0.meta.id", async (rule, source) => {
      const result = await runRuleFixture({
        rule,
        framework: "nitro",
        dependencies: { nitro: "3.0.0-beta.1", h3: "2.0.0-beta.1" },
        files: { [file]: `export default defineHandler(async (event) => { ${source} })` },
      });
      expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([rule.meta.id]);
    });

    test("applies Nitro 3 runtime config advice", async () => {
      const result = await runRuleFixture({
        rule: noEventRuntimeConfigInServer,
        framework: "nitro",
        dependencies: { nitro: "3.0.0-beta.1" },
        files: { [file]: "export default defineHandler((event) => useRuntimeConfig(event))" },
      });
      expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
        noEventRuntimeConfigInServer.meta.id,
      ]);
    });
  },
);

test.each(["api/index.ts", "routes/index.ts", "server/api/index.ts", "app/server/api/index.ts"])(
  "preserves Nitro 2 event-aware runtime config advice in %s",
  async (file) => {
    const result = await runRuleFixture({
      rule: requireEventRuntimeConfigInServer,
      framework: "nitro",
      files: { [file]: "export default defineEventHandler((event) => useRuntimeConfig())" },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      requireEventRuntimeConfigInServer.meta.id,
    ]);
  },
);

test.each(["src/main.ts", "nitro.config.ts", "components/widget.ts", "routes/index.vue"])(
  "does not classify unrelated files as server files: %s",
  async (file) => {
    const result = await runRuleFixture({
      rule: noBrowserApiInServer,
      framework: "nitro",
      files: {
        [file]: file.endsWith(".vue") ? "<script setup>document.title</script>" : "document.title",
      },
    });
    expect(result.diagnostics).toEqual([]);
  },
);

test.each(["routes/index.ts", "api/index.ts", "middleware/auth.ts"])(
  "does not treat Nuxt application files as standalone Nitro files: %s",
  async (file) => {
    const result = await runRuleFixture({
      rule: noClientComposablesInServer,
      framework: "nuxt",
      files: { [file]: "export default () => useRoute()" },
    });
    expect(result.diagnostics).toEqual([]);
  },
);

test.each([
  ["middleware/auth.ts", 1],
  ["routes/api/users.ts", 0],
])("keeps method assertions separate from route suffix advice in %s", async (file, count) => {
  const result = await runRuleFixture({
    rule: preferAssertMethod,
    framework: "nitro",
    dependencies: { nitro: "3.0.0-beta.1" },
    files: {
      [file]:
        "export default defineHandler((event) => { if (event.method !== 'POST') throw new Error() })",
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});
