import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noBrowserApiInServer } from "../../../src/rule-packs/nitro/rules/no-browser-api-in-server.ts";

test("allows typeof checks for unavailable browser globals", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noBrowserApiInServer,
    files: {
      "server/api/runtime.ts": `export default defineEventHandler(() => ({
  window: typeof window,
  document: typeof document,
  storage: typeof localStorage,
}))`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("still reports access to a browser global inside typeof", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noBrowserApiInServer,
    files: {
      "server/api/runtime.ts": `export default defineEventHandler(() => typeof window.document)`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toBe("window is not available in Nitro server runtime.");
});
