import { expect, test } from "vite-plus/test";
import { runProjectFixture, runRuleFixture } from "../../../src/core/testkit.ts";
import { noRemovedExports } from "../../../src/rule-packs/h3/rules/no-removed-exports.ts";

test.each([
  'import * as h3 from "h3"; export default event => h3.send(event, "ok")',
  'import * as h3 from "h3"; export default event => h3.sendError(event, new Error())',
  'import * as runtime from "nitro/h3"; export default event => runtime.send(event, "ok")',
  'import * as h3 from "h3"; export const respond = h3["send"]',
  'import * as h3 from "h3"; export const respond = h3[`send`]',
  'import * as h3 from "nitro/h3"; export const respond = h3?.[`sendError`]',
  'import * as h3 from "h3"; export const respond = h3?.sendError',
  'import * as h3 from "h3"; export default event => h3["sendError"](event, new Error())',
  'import * as h3 from "h3"; function helper(h3) { return h3.send() }; export const send = h3.send',
])("reports removed API reads through their H3 namespace: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noRemovedExports,
    framework: "nitro",
    dependencies: { nitro: "3.0.0-beta.1", h3: "2.0.1" },
    files: { "server/api/index.ts": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    ruleId: noRemovedExports.meta.id,
    code: "H30001",
  });
});

test.each([
  'import * as h3 from "other"; export default event => h3.send(event, "ok")',
  'const h3 = { send() {} }; export default event => h3.send(event, "ok")',
  'import * as h3 from "h3"; export default h3 => h3.send()',
  'import * as h3 from "h3"; function handler({ h3 }) { return h3.send() }',
  'import * as h3 from "h3"; export default event => h3.sendRedirect(event, "/")',
  'import * as h3 from "h3"; export default event => h3[method](event)',
  'import * as h3 from "h3"; export const respond = h3[`send${method}`]',
  'import * as h3 from "h3"; export const text = "h3.send(event)"',
])("ignores unrelated bindings and supported APIs: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noRemovedExports,
    framework: "nitro",
    dependencies: { nitro: "3.0.0-beta.1", h3: "2.0.1" },
    files: { "server/api/index.ts": source },
  });
  expect(result.diagnostics).toEqual([]);
});

test("keeps H3 v1 namespace helpers valid", async () => {
  const result = await runRuleFixture({
    rule: noRemovedExports,
    framework: "nitro",
    dependencies: { nitropack: "2.13.4", h3: "1.15.11" },
    files: {
      "server/api/index.ts":
        'import * as h3 from "h3"; export default event => h3.send(event, "ok")',
    },
  });
  expect(result.diagnostics).toEqual([]);
});

async function diagnoseH3(source: string, h3 = "2.0.8") {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { h3 },
    files: { "src/server.ts": source },
    rules: [noRemovedExports],
    run: { runtimeTarget: { h3 } },
  });
  return result.diagnostics;
}

test.each([
  [
    'import { MIMES } from "h3"; export const type = MIMES.json',
    "MIMES export",
    '"application/json"',
  ],
  [
    'import { isStream as stream } from "h3"; export { stream }',
    "isStream export",
    "ReadableStream",
  ],
  [
    'import { toWebRequest } from "nitro/h3"; export { toWebRequest }',
    "toWebRequest export",
    "event.req",
  ],
  [
    'import * as h3 from "h3"; export const ok = h3.isWebResponse(value)',
    "isWebResponse export",
    "Response",
  ],
  [
    'import * as h3 from "h3"; export const create = h3["createEvent"]',
    "createEvent export",
    "toNodeHandler",
  ],
  ['import { use } from "h3"; export { use }', "use export", "app.use()"],
  [
    'import { "splitCookiesString" as split } from "h3"; export { split }',
    "splitCookiesString",
    "cookie-es",
  ],
  ['export { defineRequestMiddleware } from "h3"', "defineRequestMiddleware", "onRequest()"],
  ['import type { App } from "h3"; export let app: App', "App type", "H3 class"],
  [
    'import { type AppOptions } from "h3"; export let options: AppOptions',
    "AppOptions type",
    "H3Config",
  ],
  ['import type { Layer } from "h3"; export let layer: Layer', "Layer type", "declare it locally"],
  [
    'import type { send } from "h3"; export let fn: typeof send',
    "send export",
    "Return the response value",
  ],
])("reports each removed value and type: %s", async (source, message, fix) => {
  const diagnostics = await diagnoseH3(source);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ ruleId: noRemovedExports.meta.id, code: "H30001" });
  expect(diagnostics[0]!.message).toContain(message);
  expect(diagnostics[0]!.suggestion ?? diagnostics[0]!.diagnostic.fix).toContain(fix);
});

test("reports each removed name in one import", async () => {
  const diagnostics = await diagnoseH3(
    'import { H3, send, sendError, type App, getQuery } from "h3"; export { H3, send, sendError, getQuery }; export let app: App',
  );
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    expect.stringContaining("send export"),
    expect.stringContaining("sendError export"),
    expect.stringContaining("App type"),
  ]);
});

test.each([
  // Deprecated in v2 but still exported by 2.0.8.
  'import { createApp, createRouter, createError, getHeader, getMethod, readMultipartFormData, setResponseStatus, useBase, eventHandler, H3Error } from "h3"; export { createApp, createRouter, createError, getHeader, getMethod, readMultipartFormData, setResponseStatus, useBase, eventHandler, H3Error }',
  'import type { EventHandler, H3Event, H3EventContext, HTTPMethod, TypedHeaders } from "h3"; export type T = [EventHandler, H3Event, H3EventContext, HTTPMethod, TypedHeaders]',
  'import { MIMES } from "./mimes"; export const json = MIMES.json',
  'import * as h3 from "h3"; export const App = h3.H3; export const value = h3.createApp',
  'export { MIMES } from "./mimes"',
])("ignores names H3 v2 still exports and other modules: %s", async (source) => {
  expect(await diagnoseH3(source)).toEqual([]);
});

test("keeps H3 v1 exports valid on H3 v1", async () => {
  expect(
    await diagnoseH3(
      'import { MIMES, isStream, use, type App } from "h3"; import * as h3 from "h3"; export const sent = h3.send; export { MIMES, isStream, use }; export let app: App',
      "1.15.11",
    ),
  ).toEqual([]);
});
