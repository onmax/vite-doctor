import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noExactPathUse } from "../../../src/rule-packs/h3/rules/no-exact-path-use.ts";

async function diagnose(source: string, h3 = "2.0.8") {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { h3 },
    files: { "src/server.ts": source },
    rules: [noExactPathUse],
    run: { runtimeTarget: { h3 } },
  });
  return result.diagnostics;
}

test.each([
  ['import { H3 } from "h3"; const app = new H3(); app.use("/api", (event) => {})', '"/api/**"'],
  [
    'import { H3 } from "h3"; const app = new H3(); app.use("/api/", async (event, next) => next())',
    '"/api/**"',
  ],
  [
    'import { H3 } from "h3"; const app = new H3(); function auth(event) {} app.use("/admin", auth)',
    '"/admin/**"',
  ],
  [
    'import { H3, defineHandler } from "h3"; const app = new H3(); const auth = defineHandler(() => {}); app.use("/admin", auth)',
    '"/admin/**"',
  ],
  [
    'import { createApp, fromNodeMiddleware } from "h3"; const app = createApp(); app.use("/static", fromNodeMiddleware(serveStatic))',
    '"/static/**"',
  ],
  [
    'import { H3, onRequest } from "h3"; new H3().get("/", handler).use(`/api`, onRequest(log))',
    '"/api/**"',
  ],
  ['import { H3 } from "h3"; const app = new H3(); app.use("/", (event) => {})', "without a path"],
])("reports middleware registered on a literal path: %s", async (source, fix) => {
  const diagnostics = await diagnose(source);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    ruleId: noExactPathUse.meta.id,
    code: "H30020",
    severity: "warn",
  });
  expect(diagnostics[0]!.suggestion ?? diagnostics[0]!.diagnostic.fix).toContain(fix);
});

test.each([
  'import { H3 } from "h3"; const app = new H3(); app.use("/api/**", (event) => {})',
  'import { H3 } from "h3"; const app = new H3(); app.use("/users/:id", (event) => {})',
  'import { H3 } from "h3"; const app = new H3(); app.use((event) => {})',
  'import { H3 } from "h3"; const app = new H3(); app.use("", (event) => {})',
  // A sub-app keeps prefix matching.
  'import { H3 } from "h3"; const app = new H3(); const api = new H3(); app.use("/api", api)',
  'import { H3 } from "h3"; import { api } from "./api"; const app = new H3(); app.use("/api", api)',
  'import { H3 } from "h3"; const app = new H3(); app.use("/api", createApiApp())',
  'import { H3 } from "h3"; const app = new H3(); app.use(prefix, (event) => {})',
  'import { H3 } from "h3"; const app = new H3(); app.get("/api", (event) => "ok")',
  // Same method on things that are not h3 apps.
  'import { H3 } from "h3"; const server = express(); server.use("/api", (req, res, next) => next())',
  'import { H3 } from "h3"; import { Hono } from "hono"; const hono = new Hono(); hono.use("/api", async (c, next) => next())',
])("ignores wildcard paths, sub-apps, and non-h3 receivers: %s", async (source) => {
  expect(await diagnose(source)).toEqual([]);
});

test("keeps prefix middleware valid on H3 v1", async () => {
  expect(
    await diagnose(
      'import { createApp } from "h3"; const app = createApp(); app.use("/api", (event) => {})',
      "1.15.11",
    ),
  ).toEqual([]);
});
