import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noConflictingUseFetchImport } from "../../../src/rule-packs/nuxt/rules/nuxt/no-conflicting-use-fetch-import.ts";

test("keeps conflicting useFetch renames as suggestions", async () => {
  const result = await runRuleFixture({
    rule: noConflictingUseFetchImport,
    framework: "nuxt",
    files: {
      "app/composables/useThing.ts": `import { useFetch } from "@vueuse/core";
export const useThing = () => useFetch("/api");`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("NUXT0035");
  expect(result.diagnostics[0]?.fix).toBeFalsy();
  expect(noConflictingUseFetchImport.meta.fixable).toBe("suggestion");
});

test("accepts an explicit non-conflicting useFetch import alias", async () => {
  const result = await runRuleFixture({
    rule: noConflictingUseFetchImport,
    framework: "nuxt",
    files: {
      "app/composables/useThing.ts": `import { useFetch as useVueUseFetch } from "@vueuse/core";
export const useThing = () => useVueUseFetch("/api");`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});
