import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noProcessEnvInServer } from "../../../src/rule-packs/nitro/rules/no-process-env-in-server.ts";

test("reports process.env reads in server routes and utils", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noProcessEnvInServer,
    files: {
      "server/api/mail.post.ts": `export default defineEventHandler(() => ({ from: process.env.MAIL_FROM, all: process.env }))`,
    },
  });

  expect(result.diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
    "process.env.MAIL_FROM is read directly in Nitro server code.",
    "process.env is read directly in Nitro server code.",
  ]);
});

test("allows NODE_ENV and code outside the server", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noProcessEnvInServer,
    files: {
      "server/api/mode.get.ts": `export default defineEventHandler(() => process.env.NODE_ENV)`,
      "scripts/seed.ts": `console.log(process.env.DATABASE_URL)`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});
