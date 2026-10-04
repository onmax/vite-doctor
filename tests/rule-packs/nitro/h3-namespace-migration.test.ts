import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noRemovedH3Send } from "../../../src/rule-packs/nitro/rules/no-removed-h3-send.ts";

test.each([
  'import * as h3 from "h3"; export default event => h3.send(event, "ok")',
  'import * as h3 from "h3"; export default event => h3.sendError(event, new Error())',
  'import * as runtime from "nitro/h3"; export default event => runtime.send(event, "ok")',
  'import * as h3 from "h3"; export const respond = h3["send"]',
  'import * as h3 from "h3"; export const respond = h3?.sendError',
  'import * as h3 from "h3"; export default event => h3["sendError"](event, new Error())',
  'import * as h3 from "h3"; function helper(h3) { return h3.send() }; export const send = h3.send',
])("reports removed API reads through their H3 namespace: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noRemovedH3Send,
    framework: "nitro",
    dependencies: { nitro: "3.0.0-beta.1", h3: "2.0.1" },
    files: { "server/api/index.ts": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    ruleId: noRemovedH3Send.meta.id,
    code: "NITRO0015",
  });
});

test.each([
  'import * as h3 from "other"; export default event => h3.send(event, "ok")',
  'const h3 = { send() {} }; export default event => h3.send(event, "ok")',
  'import * as h3 from "h3"; export default h3 => h3.send()',
  'import * as h3 from "h3"; function handler({ h3 }) { return h3.send() }',
  'import * as h3 from "h3"; export default event => h3.sendRedirect(event, "/")',
  'import * as h3 from "h3"; export default event => h3[method](event)',
  'import * as h3 from "h3"; export const text = "h3.send(event)"',
])("ignores unrelated bindings and supported APIs: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noRemovedH3Send,
    framework: "nitro",
    dependencies: { nitro: "3.0.0-beta.1", h3: "2.0.1" },
    files: { "server/api/index.ts": source },
  });
  expect(result.diagnostics).toEqual([]);
});

test("keeps H3 v1 namespace helpers valid", async () => {
  const result = await runRuleFixture({
    rule: noRemovedH3Send,
    framework: "nitro",
    dependencies: { nitropack: "2.13.4", h3: "1.15.11" },
    files: {
      "server/api/index.ts":
        'import * as h3 from "h3"; export default event => h3.send(event, "ok")',
    },
  });
  expect(result.diagnostics).toEqual([]);
});
