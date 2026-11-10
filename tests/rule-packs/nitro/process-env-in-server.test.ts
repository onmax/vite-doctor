import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noProcessEnvInServer } from "../../../src/rule-packs/nitro/rules/no-process-env-in-server.ts";

test("reports process.env reads in server routes", async () => {
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

test.each(["utils", "server/utils", "plugins", "server/plugins"])(
  "reports standalone Nitro environment reads in %s",
  async (directory) => {
    const result = await runRuleFixture({
      framework: "nitro",
      rule: noProcessEnvInServer,
      files: { [`${directory}/mail.ts`]: `export const from = process.env.MAIL_FROM` },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NITRO0026"]);
  },
);

test("allows pure environment writes and deletions but reports read-modify-write access", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: noProcessEnvInServer,
    files: {
      "server/plugins/timezone.ts": `process.env.TZ = 'Etc/UTC'
delete process.env.OLD_SETTING
process.env = {}
process.env.COUNT += '1'
process.env.COUNT++
process.env.TZ = process.env.DEFAULT_TZ`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
    "process.env.COUNT is read directly in Nitro server code.",
    "process.env.COUNT is read directly in Nitro server code.",
    "process.env.DEFAULT_TZ is read directly in Nitro server code.",
  ]);
});

test("ignores shadowed process identifiers and build-time files", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: noProcessEnvInServer,
    files: {
      "server/utils/format.ts": `export function format(process: { env: string }) { return process.env.toUpperCase() }`,
      "server/utils/imported.ts": `import process from './settings'; export const from = process.env.MAIL_FROM`,
      "nuxt.config.ts": `export default defineNuxtConfig({ runtimeConfig: { mailFrom: process.env.MAIL_FROM } })`,
      "scripts/seed.ts": `console.log(process.env.DATABASE_URL)`,
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("exempts only statically named NODE_ENV reads", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: noProcessEnvInServer,
    files: {
      "server/utils/mode.ts": `const NODE_ENV = 'MAIL_FROM'
console.log(process.env.NODE_ENV, process.env['NODE_ENV'])
console.log(process.env[NODE_ENV], process.env['MAIL_FROM'])`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
    "process.env is read directly in Nitro server code.",
    "process.env.MAIL_FROM is read directly in Nitro server code.",
  ]);
});
