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
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-html-"));
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
    "server/routes/index.ts": handler,
  });

const hits = (result: DoctorRunResult) =>
  result.diagnostics
    .filter((item) => item.code === "H30013")
    .map((item) => ({ line: item.range?.line, fix: item.suggestion }));

test("reports html() called with a plain string of markup", async () => {
  const root = h3Project(`import { H3, defineEventHandler, html } from "h3"
export const app = new H3()
  .get("/a", () => html("<h1>Hello</h1>"))
  .get("/b", (event) => html(\`<p>\${event.path}</p>\`))
export const page = defineEventHandler(() => html('<!doctype html><title>x</title>'))
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result)).toEqual([
    { line: 3, fix: expect.stringContaining("html`<h1>Hello</h1>`") },
    { line: 4, fix: expect.stringContaining("html`<p>${event.path}</p>`") },
    { line: 5, fix: expect.stringContaining("html`<!doctype html><title>x</title>`") },
  ]);
});

test("reports an auto-imported html() in a Nitro route", async () => {
  const root = nitroProject(`export default defineHandler(() => html("<main>home</main>"))
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result).map((item) => item.line)).toEqual([1]);
});

test("stays silent for tagged templates, raw(), text, local helpers, and older h3", async () => {
  const v2 = h3Project(`import { H3, html, raw } from "h3"
const markup = "<p>trusted</p>"
export const app = new H3()
  .get("/a", (event) => html\`<p>\${event.path}</p>\`)
  .get("/b", () => html(raw("<p>trusted</p>")))
  .get("/c", () => html("1 < 2 & 3 > 2"))
  .get("/d", () => html(markup))
`);
  const local = h3Project(`import { H3 } from "h3"
const html = (markup) => new Response(markup, { headers: { "content-type": "text/html" } })
export const app = new H3().get("/a", () => html("<h1>Hello</h1>"))
`);
  const beforeEscaping = h3Project(
    `import { H3, html } from "h3"
export const app = new H3().get("/a", () => html("<h1>Hello</h1>"))
`,
    "2.0.0-rc.4",
  );
  for (const root of [v2, local, beforeEscaping]) {
    const result = await runViteDoctor({ root, cache: false });
    expect(hits(result)).toEqual([]);
  }
});
