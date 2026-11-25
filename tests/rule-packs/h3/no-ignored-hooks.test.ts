import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noIgnoredHooks } from "../../../src/rule-packs/h3/rules/no-ignored-hooks.ts";

async function diagnose(source: string, h3 = "2.0.8") {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { h3 },
    files: { "src/server.ts": source },
    rules: [noIgnoredHooks],
    run: { runtimeTarget: { h3 } },
  });
  return result.diagnostics;
}

test.each([
  [
    'import { defineEventHandler } from "h3"; export default defineEventHandler({ onRequest: [auth], handler: () => "ok" })',
    "onRequest",
  ],
  [
    'import { eventHandler } from "h3"; export default eventHandler({ handler: () => "ok", onBeforeResponse: [log] })',
    "onBeforeResponse",
  ],
  [
    'import { defineHandler } from "h3"; export default defineHandler({ "onRequest": auth, handler: () => "ok" })',
    "onRequest",
  ],
  [
    'import * as h3 from "h3"; export default h3.defineEventHandler({ onRequest: auth, handler: () => "ok" })',
    "onRequest",
  ],
  [
    'import { H3 } from "h3"; export const app = new H3({ onBeforeResponse(event) { log(event) } })',
    "onBeforeResponse",
  ],
  [
    'import { createApp } from "h3"; export const app = createApp({ debug: true, onAfterResponse: log })',
    "onAfterResponse",
  ],
  [
    'import { createRouter } from "nitro/h3"; export const router = createRouter({ onBeforeResponse: log })',
    "onBeforeResponse",
  ],
])("reports a v1 hook H3 v2 never calls: %s", async (source, hook) => {
  const diagnostics = await diagnose(source);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ ruleId: noIgnoredHooks.meta.id, code: "H30018" });
  expect(diagnostics[0]!.message).toContain(hook);
});

test("reports both hooks on one handler object", async () => {
  const diagnostics = await diagnose(
    'import { defineEventHandler } from "h3"; export default defineEventHandler({ onRequest: [auth], onBeforeResponse: [log], handler: () => "ok" })',
  );
  expect(diagnostics).toHaveLength(2);
});

test.each([
  // App-level onRequest still runs in H3 v2.
  'import { H3 } from "h3"; export const app = new H3({ onRequest: log, onResponse: log, onError: log })',
  'import { defineHandler, onRequest } from "h3"; export default defineHandler({ middleware: [onRequest(auth)], handler: () => "ok" })',
  'import { defineEventHandler } from "h3"; export default defineEventHandler(() => "ok")',
  'import { defineEventHandler } from "h3"; const options = { onRequest: auth, handler: () => "ok" }; export default defineEventHandler(options)',
  'import { H3 } from "h3"; const defineEventHandler = (input) => input; export const app = new H3(); export default defineEventHandler({ onRequest: auth })',
  'import { defineEventHandler } from "other"; export default defineEventHandler({ onRequest: auth, handler: () => "ok" })',
  'import { H3 } from "h3"; class App { constructor(options) {} } export const app = new App({ onBeforeResponse: log })',
  'import { H3 } from "h3"; export const app = new H3({ [hookName]: log })',
])("ignores v2 hooks and unrelated objects: %s", async (source) => {
  expect(await diagnose(source)).toEqual([]);
});

test("keeps H3 v1 hooks valid on H3 v1", async () => {
  expect(
    await diagnose(
      'import { createApp, defineEventHandler } from "h3"; export const app = createApp({ onBeforeResponse: log }); export default defineEventHandler({ onRequest: [auth], handler: () => "ok" })',
      "1.15.11",
    ),
  ).toEqual([]);
});
