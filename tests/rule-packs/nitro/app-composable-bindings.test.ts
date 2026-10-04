import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noClientComposablesInServer } from "../../../src/rule-packs/nitro/rules/no-client-composables-in-server.ts";

test.each([
  'import { useState as readState } from "#imports"; export default defineEventHandler(() => readState())',
  'import { useState } from "#imports"; export default defineEventHandler(() => useState())',
  'function useState() { return "healthy" }; export default defineEventHandler(() => useState())',
  'const useFetch = () => "ok"; export default defineEventHandler(() => useFetch())',
  "export default defineEventHandler(useRoute => useRoute())",
  "function handler({ useHead }) { return useHead() }; export default handler",
  "try { task() } catch (useState) { useState() }",
  'import { useState } from "./state"; export default defineEventHandler(() => useState())',
  'import { useFetch } from "ofetch"; export default defineEventHandler(() => useFetch())',
  "export default defineEventHandler(() => database.useState())",
  'import * as utils from "./utils"; export default defineEventHandler(() => utils.useRoute())',
  'import { useState } from "#app"; function handler(useState) { return useState() }',
  'import * as app from "#app"; function handler(app) { return app.useState() }',
])("does not mistake local and unrelated APIs for app composables: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noClientComposablesInServer,
    framework: "nuxt",
    files: { "server/api/health.ts": source },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["export default defineEventHandler(() => useState())", "useState"],
  ["export default defineEventHandler(() => useFetch())", "useFetch"],
  [
    'import { useState } from "#app"; export default defineEventHandler(() => useState())',
    "useState",
  ],
  [
    'import { useState as readState } from "#app"; export default defineEventHandler(() => readState())',
    "useState",
  ],
  [
    'import { useHead as head } from "nuxt/app"; export default defineEventHandler(() => head())',
    "useHead",
  ],
  [
    'import * as app from "#app"; export default defineEventHandler(() => app.useRoute())',
    "useRoute",
  ],
  [
    'import * as app from "nuxt/app"; export default defineEventHandler(() => app["useState"]())',
    "useState",
  ],
  [
    'import { useRouter } from "#app"; function helper(useRouter) { return useRouter() }; export default defineEventHandler(() => useRouter())',
    "useRouter",
  ],
])("retains diagnostics for Nuxt-owned composables: %s", async (source, name) => {
  const result = await runRuleFixture({
    rule: noClientComposablesInServer,
    framework: "nuxt",
    files: { "server/api/health.ts": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    ruleId: noClientComposablesInServer.meta.id,
    message: `${name}() is a Nuxt app composable and is not available in Nitro server files.`,
  });
});
