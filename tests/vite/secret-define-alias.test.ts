import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noSecretDefine } from "../../src/rule-packs/vite/rules/define.ts";

test("finds a secret source hidden behind local define aliases", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const privateValue = process.env.PRIVATE_TOKEN
const replacement = privateValue
export default { define: {
  __CONFIG__: JSON.stringify(replacement),
} }`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(noSecretDefine.meta.id);
});

test("does not classify a public local alias as a secret", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: noSecretDefine,
    files: {
      "vite.config.ts": `const replacement = process.env.PUBLIC_VERSION
export default { define: {
  __CONFIG__: JSON.stringify(replacement),
} }`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noSecretDefine.meta.id)).toBe(false);
});
