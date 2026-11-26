import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noRemovedRouterApi } from "../../../src/rule-packs/h3/rules/no-removed-router-api.ts";

async function diagnose(source: string, h3 = "2.0.8") {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { h3 },
    files: { "src/server.ts": source },
    rules: [noRemovedRouterApi],
    run: { runtimeTarget: { h3 } },
  });
  return result.diagnostics;
}

test.each([
  [
    'import { createRouter } from "h3"; const router = createRouter(); router.add("/users", handler, "get")',
    "router.add()",
  ],
  [
    'import { createApp } from "h3"; export const app = createApp(); export const layer = app.resolve("/api")',
    "app.resolve()",
  ],
  [
    'import { createApp } from "h3"; const app = createApp(); export const size = app.stack.length',
    "app.stack",
  ],
  ['import { H3 } from "h3"; new H3().get("/", handler).add("/x", handler)', "router.add()"],
  [
    'import { H3 } from "h3"; class Server { app = new H3(); routes() { return this.app.stack } }',
    "app.stack",
  ],
  [
    'import type { H3 } from "h3"; export function setup(app: H3) { app.add("/x", handler) }',
    "router.add()",
  ],
  [
    'import { createApp } from "h3"; const app = createApp(); app.use(["/a", "/b"], handler)',
    "array",
  ],
  [
    'import { createApp } from "h3"; const app = createApp(); app.use("/a", [auth, handler])',
    "array",
  ],
  [
    'import { createApp } from "h3"; const app = createApp(); app.use("/docs", () => import("./docs"), { lazy: true })',
    "lazy",
  ],
  [
    'import { createApp } from "h3"; const app = createApp(); app.use(() => handler, { lazy: true })',
    "lazy",
  ],
  [
    'import { createApp } from "h3"; const app = createApp(); app.use({ route: "/x", handler })',
    "layer object",
  ],
])("reports a router API H3 v2 removed: %s", async (source, fragment) => {
  const diagnostics = await diagnose(source);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ ruleId: noRemovedRouterApi.meta.id, code: "H30019" });
  expect(diagnostics[0]!.message).toContain(fragment);
});

test.each([
  'import { H3 } from "h3"; const app = new H3(); app.on("GET", "/users", handler); app.get("/x", handler)',
  'import { H3 } from "h3"; const app = new H3(); app.use("/api/**", auth); app.use(auth); app.mount("/sub", sub)',
  'import { H3, defineLazyEventHandler } from "h3"; const app = new H3(); app.use("/docs", defineLazyEventHandler(() => import("./docs")), { lazy: true })',
  'import { H3, defineLazyEventHandler } from "h3"; const app = new H3(); const docs = defineLazyEventHandler(() => import("./docs")); app.use(docs, { lazy: true })',
  'import { H3 } from "h3"; const app = new H3(); app.use("/x", handler, { lazy: false })',
  'import { H3 } from "h3"; const app = new H3(); export const response = app.fetch(new Request("http://x/"))',
  // Same member names on things that are not h3 apps.
  'import { H3 } from "h3"; const set = new Set(); set.add(1); export const resolved = Promise.resolve(1)',
  'import { H3 } from "h3"; const router = createRouter(); router.add("/x", handler); export const app = new H3()',
  'import { createRouter } from "radix3"; import { H3 } from "h3"; const router = createRouter(); router.add("/x", {}); export const app = new H3()',
  'import { H3 } from "h3"; const express = createExpress(); express.use(["/a", "/b"], handler); export const stack = express.stack',
  'import { H3 } from "h3"; class Server { app = new H3(); constructor() { this.app.add = () => {} } }',
])("ignores supported APIs and non-h3 receivers: %s", async (source) => {
  expect(await diagnose(source)).toEqual([]);
});

test("keeps H3 v1 router APIs valid on H3 v1", async () => {
  expect(
    await diagnose(
      'import { createApp, createRouter } from "h3"; const app = createApp(); const router = createRouter(); router.add("/x", handler); app.use(["/a", "/b"], handler); app.use("/docs", () => import("./docs"), { lazy: true }); export const stack = app.stack',
      "1.15.11",
    ),
  ).toEqual([]);
});
