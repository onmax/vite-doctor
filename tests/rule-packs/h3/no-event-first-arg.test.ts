import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.ts";
import type { DoctorRunResult } from "../../../src/core/primitives.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-event-first-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const h3Project = (server: string, version = "2.0.8") =>
  fixture({
    "package.json": JSON.stringify({ type: "module", dependencies: { h3: version } }),
    "node_modules/h3/package.json": JSON.stringify({ name: "h3", version }),
    "src/server.ts": server,
  });

const nitroProject = (handler: string) =>
  fixture({
    "package.json": JSON.stringify({ dependencies: { nitro: "3.0.0-beta.4" } }),
    "node_modules/nitro/package.json": JSON.stringify({
      name: "nitro",
      version: "3.0.0-beta.4",
      dependencies: { h3: "2.0.8" },
    }),
    "node_modules/nitro/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: "2.0.8",
    }),
    "server/routes/go.ts": handler,
  });

const hits = (result: DoctorRunResult) =>
  result.diagnostics
    .filter((item) => item.code === "H30010")
    .map((item) => ({ line: item.range?.line, fix: item.suggestion }));

test("reports v2 response helpers called with the handler's event first", async () => {
  const root =
    h3Project(`import { H3, defineHandler, html, iterable, noContent, redirect, sendWebResponse } from "h3"
export const app = new H3()
  .get("/a", (event) => redirect(event, "/login", 301))
  .get("/b", (req) => noContent(req))
  .get("/c", (event) => html(event, "<p>hi</p>"))
  .get("/d", (event) => iterable(event, [1, 2]))
  .get("/e", (event) => sendWebResponse(event, new Response("ok")))
export const later = defineHandler((event) => {
  if (!event.context.user) return redirect(event, "/login")
  return "ok"
})
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result)).toEqual([
    { line: 3, fix: expect.stringContaining('redirect("/login", 301)') },
    { line: 4, fix: expect.stringContaining("noContent()") },
    { line: 5, fix: expect.stringContaining('html("<p>hi</p>")') },
    { line: 6, fix: expect.stringContaining("iterable([1, 2])") },
    { line: 7, fix: expect.stringContaining('sendWebResponse(new Response("ok"))') },
    { line: 9, fix: expect.stringContaining('redirect("/login")') },
  ]);
});

test("reports auto-imported helpers in a Nitro route", async () => {
  const root = nitroProject(`export default defineEventHandler((event) => redirect(event, "/next"))
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result).map((item) => item.line)).toEqual([1]);
});

test("stays silent for v2 usage, local helpers, non-event arguments, h3 1.x, and non-handlers", async () => {
  const v2 = h3Project(`import { H3, redirect, noContent, redirectBack, html } from "h3"
const event = "/elsewhere"
function guard(event) {
  return redirect(event)
}
export const app = new H3()
  .get("/a", () => redirect("/login"))
  .get("/b", () => noContent(204))
  .get("/c", (event) => redirectBack(event))
  .get("/d", (event) => html\`<p>\${event.path}</p>\`)
  .get("/e", () => redirect(event))
`);
  const local = h3Project(`import { H3 } from "h3"
const redirect = (event, to) => Response.redirect(new URL(to, event.url))
export const app = new H3().get("/a", (event) => redirect(event, "/login"))
`);
  const v1 = h3Project(
    `import { createApp, defineEventHandler, sendWebResponse } from "h3"
export const app = createApp().use(
  defineEventHandler((event) => sendWebResponse(event, new Response("ok"))),
)
`,
    "1.15.4",
  );
  for (const root of [v2, local, v1]) {
    const result = await runViteDoctor({ root, cache: false });
    expect(hits(result)).toEqual([]);
  }
});
