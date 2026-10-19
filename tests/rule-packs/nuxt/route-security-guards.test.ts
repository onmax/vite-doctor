import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noRouteMiddlewareApiSecurity } from "../../../src/rule-packs/nuxt/rules/nuxt.ts";

const RULE_ID = "nuxt/middleware/no-route-middleware-api-security";
const H3_V2 = { h3: "2.0.0", nitro: "3.0.0", nuxt: "5.0.0" };
const middleware = {
  "app/middleware/auth.ts": "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
};

// Drop's identity utils: guards that throw h3 v2 HTTPErrors with 401 and 403.
const identity = `import { type H3Event, HTTPError } from "h3"
export async function identify(event: H3Event) { return event.context.user ?? null }
export async function requireIdentity(event: H3Event) {
  const who = await identify(event)
  if (who) return who
  event.res.headers.set("WWW-Authenticate", 'Bearer realm="drop"')
  throw new HTTPError({ status: 401, statusText: "Sign in." })
}
export async function requireAdmin(event: H3Event) {
  const who = await requireIdentity(event)
  if (who.role !== "admin") throw new HTTPError({ status: 403, statusText: "Admins only." })
  return who
}`;

async function reported(
  files: Record<string, string>,
  options: { dependencies?: Record<string, string>; guards?: string[] } = {},
) {
  const result = await runProjectFixture({
    framework: "nuxt",
    dependencies: options.dependencies ?? H3_V2,
    rules: [noRouteMiddlewareApiSecurity],
    config: options.guards
      ? { rules: { [RULE_ID]: ["warn", { guards: options.guards }] } }
      : undefined,
    files: { ...middleware, ...files },
  });
  return result.diagnostics
    .filter((diagnostic) => diagnostic.ruleId === RULE_ID)
    .map((diagnostic) => diagnostic.file?.replace(/^.*?(?=server\/)/, ""));
}

describe("H3 v2 and Nitro 3 handler factories", () => {
  test.each([
    "export default defineHandler(async (event) => { await requireUserSession(event); return {} })",
    "import { defineHandler } from 'h3'; export default defineHandler(async (event) => { const { user } = await requireUserSession(event); return user })",
    "import { defineHandler as handle } from 'h3'; export default handle(async (event) => { await requireUserSession(event); return {} })",
    "export default defineHandler({ handler: async (event) => { await requireUserSession(event); return {} } })",
    "export default defineValidatedHandler({ validate: { body: Schema }, async handler(event) { await requireUserSession(event); return {} } })",
    "export default defineValidatedHandler({ validate: { body: Schema }, handler: async (event) => { await requireUserSession(event); return {} } })",
    "export default defineCachedHandler(async (event) => { await requireUserSession(event); return {} }, { maxAge: 60 })",
  ])("accepts a guarded handler: %s", async (handler) => {
    expect(await reported({ "server/api/admin/index.get.ts": handler })).toEqual([]);
  });

  test("does not trust defineHandler when the resolved H3 is v1", async () => {
    expect(
      await reported(
        {
          "server/api/admin/index.get.ts":
            "export default defineHandler(async (event) => { await requireUserSession(event); return {} })",
        },
        { dependencies: { h3: "1.15.0", nitropack: "2.12.0", nuxt: "4.0.0" } },
      ),
    ).toEqual(["server/api/admin/index.get.ts"]);
  });

  test("still reports an unguarded defineValidatedHandler", async () => {
    expect(
      await reported({
        "server/api/admin/index.post.ts":
          "export default defineValidatedHandler({ validate: { body: Schema }, async handler(event) { return event.req.json() } })",
      }),
    ).toEqual(["server/api/admin/index.post.ts"]);
  });
});

describe("app guards proven by their implementation", () => {
  test.each([
    `import { requireAdmin } from "../../../utils/identity"
export default defineHandler(async (event) => {
  await requireAdmin(event)
  return []
})`,
    `import { defineValidatedHandler } from "h3"
import { requireAdmin } from "../../../utils/identity"
export default defineValidatedHandler({
  validate: { body: Schema },
  async handler(event) {
    const who = await requireAdmin(event)
    return { by: who.userId }
  },
})`,
    `import { requireIdentity } from "~~/server/utils/identity"
export default defineHandler(async (event) => {
  const who = await requireIdentity(event)
  return who
})`,
    `export default defineHandler(async (event) => {
  await requireAdmin(event)
  return []
})`,
  ])("accepts an awaited guard that throws 401 or 403: %s", async (handler) => {
    expect(
      await reported({
        "server/utils/identity.ts": identity,
        "server/api/admin/reports/index.get.ts": handler,
      }),
    ).toEqual([]);
  });

  test("follows guards re-exported from another module", async () => {
    expect(
      await reported({
        "server/utils/identity.ts": identity,
        "server/utils/guards.ts": 'export { requireAdmin as adminOnly } from "./identity"',
        "server/api/admin/index.get.ts": `import { adminOnly } from "../../utils/guards"
export default defineHandler(async (event) => { await adminOnly(event); return [] })`,
      }),
    ).toEqual([]);
  });

  test("accepts a synchronous guard without await", async () => {
    expect(
      await reported({
        "server/utils/token.ts": `export function requireToken(event) {
  if (event.req.headers.get("authorization") !== "Bearer secret") throw createError({ statusCode: 401 })
  return true
}`,
        "server/api/admin/index.get.ts":
          "export default defineHandler((event) => { requireToken(event); return [] })",
      }),
    ).toEqual([]);
  });

  test.each([
    [
      "throws a non-auth status",
      "export async function requireAdmin(event) { if (!event.context.user) throw new HTTPError({ status: 400 }); return event.context.user }",
    ],
    [
      "can answer with no identity",
      "export async function requireAdmin(event) { if (event.context.banned) throw new HTTPError({ status: 403 }); if (!event.context.user) return null; return event.context.user }",
    ],
    [
      "catches its own auth error",
      "export async function requireAdmin(event) { try { if (!event.context.user) throw new HTTPError({ status: 401 }) } catch {} return event.context.user }",
    ],
    [
      "only throws inside a callback",
      "export async function requireAdmin(event) { [event].forEach(() => { throw new HTTPError({ status: 401 }) }); return event.context.user }",
    ],
  ])("does not accept a function that %s", async (_, implementation) => {
    expect(
      await reported({
        "server/utils/identity.ts": implementation,
        "server/api/admin/index.get.ts": `import { requireAdmin } from "../../utils/identity"
export default defineHandler(async (event) => { await requireAdmin(event); return [] })`,
      }),
    ).toEqual(["server/api/admin/index.get.ts"]);
  });

  test.each([
    "export default defineHandler(async (event) => { requireAdmin(event); return [] })",
    "export default defineHandler(async (event) => { if (event.method === 'GET') return []; await requireAdmin(event); return [] })",
    "export default defineHandler(async (event) => { await requireAdmin(other); return [] })",
    "export default defineHandler(async (event) => { const check = () => requireAdmin(event); return [] })",
  ])("does not accept a guard that may not run first: %s", async (handler) => {
    expect(
      await reported({
        "server/utils/identity.ts": identity,
        "server/api/admin/index.get.ts": `import { requireAdmin } from "../../utils/identity"\n${handler}`,
      }),
    ).toEqual(["server/api/admin/index.get.ts"]);
  });

  test("does not pick an auto-imported guard when two utils export the name", async () => {
    expect(
      await reported({
        "server/utils/identity.ts": identity,
        "server/utils/legacy.ts":
          "export async function requireAdmin(event) { return event.context.user }",
        "server/api/admin/index.get.ts":
          "export default defineHandler(async (event) => { await requireAdmin(event); return [] })",
      }),
    ).toEqual(["server/api/admin/index.get.ts"]);
  });

  test("does not trust a handler-local shadow of an imported guard", async () => {
    expect(
      await reported({
        "server/utils/identity.ts": identity,
        "server/api/admin/index.get.ts": `import { requireAdmin } from "../../utils/identity"
export default defineHandler(async (event) => {
  { const requireAdmin = () => undefined; await requireAdmin(event) }
  return []
})`,
      }),
    ).toEqual(["server/api/admin/index.get.ts"]);
  });
});

describe("guards option", () => {
  const handler = `import { requireAdmin } from "@acme/auth/server"
export default defineHandler(async (event) => {
  const who = await requireAdmin(event)
  return who
})`;

  test("reports a guard Doctor cannot follow", async () => {
    expect(await reported({ "server/api/admin/index.get.ts": handler })).toEqual([
      "server/api/admin/index.get.ts",
    ]);
  });

  test("accepts a configured guard name", async () => {
    expect(
      await reported({ "server/api/admin/index.get.ts": handler }, { guards: ["requireAdmin"] }),
    ).toEqual([]);
  });

  test("still requires the configured guard to run first with the event", async () => {
    expect(
      await reported(
        {
          "server/api/admin/index.get.ts": `import { requireAdmin } from "@acme/auth/server"
export default defineHandler(async (event) => {
  if (event.method === "HEAD") return null
  return requireAdmin(event)
})`,
        },
        { guards: ["requireAdmin"] },
      ),
    ).toEqual(["server/api/admin/index.get.ts"]);
  });
});

describe("auth provider mounts re-exported from a package", () => {
  const packages = {
    "node_modules/vite-hub/package.json": JSON.stringify({
      name: "vite-hub",
      dependencies: { "@vite-hub/auth": "0.0.4" },
    }),
    "node_modules/@vite-hub/auth/package.json": JSON.stringify({
      name: "@vite-hub/auth",
      dependencies: { "better-auth": "^1.7.7" },
    }),
  };

  test("accepts a Better Auth mount from a framework module", async () => {
    expect(
      await reported({
        ...packages,
        "server/api/auth/[...all].ts": 'export { default } from "vite-hub/auth/server"',
      }),
    ).toEqual([]);
  });

  test("accepts a mount straight from the auth package", async () => {
    expect(
      await reported({
        ...packages,
        "server/api/auth/[...all].ts": 'export { default } from "@vite-hub/auth/server"',
      }),
    ).toEqual([]);
  });

  test("accepts an npm alias whose installed manifest has another name", async () => {
    expect(
      await reported({
        "node_modules/my-auth/package.json": JSON.stringify({ name: "better-auth" }),
        "server/api/auth/[...all].ts": 'export { default } from "my-auth/server"',
      }),
    ).toEqual([]);
  });

  test.each([
    ["the package is not installed", 'export { default } from "vite-hub/auth/server"', {}],
    [
      "the package does not depend on Better Auth",
      'export { default } from "vite-hub/auth/server"',
      {
        "node_modules/vite-hub/package.json": JSON.stringify({ name: "vite-hub" }),
      },
    ],
    [
      "the specifier is not an auth entry",
      'export { default } from "vite-hub/database/server"',
      packages,
    ],
    [
      "the module adds its own exports",
      'export { default } from "vite-hub/auth/server"\nexport const debug = true',
      packages,
    ],
    ["the source is a local module", 'export { default } from "../../utils/auth"', packages],
  ])("reports it when %s", async (_, source, files) => {
    expect(await reported({ ...files, "server/api/auth/[...all].ts": source })).toEqual([
      "server/api/auth/[...all].ts",
    ]);
  });

  test("does not trust a package re-export outside the auth catch-all", async () => {
    expect(
      await reported({
        ...packages,
        "server/api/admin.ts": 'export { default } from "vite-hub/auth/server"',
      }),
    ).toEqual(["server/api/admin.ts"]);
  });
});
