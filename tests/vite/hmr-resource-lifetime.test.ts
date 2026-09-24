import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { requireDisposeForSideEffects } from "../../src/rule-packs/vite/rules/plugin-hmr.ts";

test("an unrelated dispose callback does not hide a leaked interval", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: requireDisposeForSideEffects,
    files: {
      "src/main.ts": `const timer = setInterval(refresh, 1000)
import.meta.hot.accept()
import.meta.hot.dispose(() => { console.log('disposing') })`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(
    requireDisposeForSideEffects.meta.id,
  );
});

test("a matching cleanup satisfies the rule", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: requireDisposeForSideEffects,
    files: {
      "src/main.ts": `const timer = setInterval(refresh, 1000)
import.meta.hot.accept()
import.meta.hot.dispose(() => { clearInterval(timer) })`,
    },
  });
  expect(
    result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id),
  ).toBe(false);
});

test("finds cleanup after a nested dispose block", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: requireDisposeForSideEffects,
    files: {
      "src/main.ts": `const timer = setInterval(refresh, 1000)
import.meta.hot.accept()
import.meta.hot.dispose(() => {
  if (ready) { saveState() }
  clearInterval(timer)
})`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id)).toBe(false);
});
