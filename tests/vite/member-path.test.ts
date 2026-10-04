import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { requireDisposeForSideEffects } from "../../src/rule-packs/vite/rules/plugin-hmr.ts";

test("numeric computed subscriptions remain resources", async () => {
  const result = await runRuleFixture({
    rule: requireDisposeForSideEffects,
    framework: "vite",
    files: {
      "src/main.ts": `import.meta.hot.accept(); const subscription = channels[0].subscribe(() => {});
if (import.meta.hot) import.meta.hot.dispose(() => {});`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    "vite/hmr/require-dispose-for-side-effects",
  ]);
});
