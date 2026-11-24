import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import {
  nitroRulePack,
  noImplicitMiddlewareResponse,
} from "../../../src/rule-packs/nitro/index.ts";

const nitro3 = { nitro: "3.0.0-beta.1", h3: "2.0.0-beta.1" };

async function codes(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  const result = await runRuleFixture({
    rule: noImplicitMiddlewareResponse,
    framework,
    dependencies,
    files,
  });
  return result.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.range?.line}`);
}

test("is a recommended Nitro rule", () => {
  expect(nitroRulePack.presets.recommended).toContain(noImplicitMiddlewareResponse.meta.id);
});

describe("NITRO0030 middleware that returns an assigned value", () => {
  test.each([
    [
      "an assignment arrow body",
      "defineEventHandler((event) => event.context.user = getUser(event))",
    ],
    ["a logical assignment", "eventHandler((event) => event.context.locale ??= 'en')"],
    [
      "Object.assign",
      "defineEventHandler(async (event) => Object.assign(event.context, { tenant: 'acme' }))",
    ],
    [
      "a sequence ending in an assignment",
      "defineEventHandler((event) => (event.context.a = 1, event.context.b = 2))",
    ],
    [
      "an object-syntax handler",
      "defineEventHandler({ handler: (event) => event.context.user = getUser(event) })",
    ],
  ])("reports %s in Nuxt server middleware", async (_name, handler) => {
    expect(await codes({ "server/middleware/context.ts": `export default ${handler}\n` })).toEqual([
      "NITRO0030:1",
    ]);
  });

  test("reports a returned assignment in a block body", async () => {
    expect(
      await codes(
        {
          "middleware/auth.ts": `import { defineEventHandler } from 'h3'

export default defineEventHandler(async (event) => {
  const user = await loadUser(event)
  return event.context.user = user
})
`,
        },
        "nitro",
      ),
    ).toEqual(["NITRO0030:5"]);
  });

  test("reports Nitro 3 middleware", async () => {
    expect(
      await codes(
        {
          "nitro.config.ts": "export default defineConfig({ serverDir: true })\n",
          "server/middleware/request-id.ts": `import { defineHandler } from 'nitro'

export default defineHandler((event) => event.context.requestId = crypto.randomUUID())
`,
        },
        "nitro",
        nitro3,
      ),
    ).toEqual(["NITRO0030:3"]);
  });

  test.each([
    ["a block body", "defineEventHandler((event) => { event.context.user = getUser(event) })"],
    [
      "an explicit createError",
      "defineEventHandler(() => { return createError({ statusCode: 401 }) })",
    ],
    ["an explicit redirect", "defineEventHandler((event) => sendRedirect(event, '/login'))"],
    ["an assignment of undefined", "defineEventHandler((event) => event.context.user = undefined)"],
    [
      "an assignment returned by a nested function",
      "defineEventHandler((event) => { event.context.load = () => { return cache = fetchUser() } })",
    ],
  ])("stays quiet for %s", async (_name, handler) => {
    expect(await codes({ "server/middleware/context.ts": `export default ${handler}\n` })).toEqual(
      [],
    );
  });

  test("stays quiet outside middleware and for a local handler factory", async () => {
    expect(
      await codes({
        "server/api/user.ts":
          "export default defineEventHandler((event) => event.context.user = 1)\n",
        "server/middleware/local.ts": `import { defineEventHandler } from '../utils/handler'
export default defineEventHandler((event) => event.context.user = 1)
`,
      }),
    ).toEqual([]);
  });

  test.each([
    [
      "custom ignore patterns",
      {
        "nuxt.config.ts":
          "export default defineNuxtConfig({ ignore: ['server/middleware/legacy/**'] })\n",
      },
    ],
    ["a .nuxtignore file", { ".nuxtignore": "server/middleware/context.ts\n" }],
  ])("records an evidence gap for %s", async (_name, files) => {
    expect(
      await codes({
        ...files,
        "server/middleware/context.ts":
          "export default defineEventHandler((event) => event.context.user = 1)\n",
      }),
    ).toEqual([]);
  });
});
