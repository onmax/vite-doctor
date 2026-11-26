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
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-discarded-"));
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

const nuxtProject = (handler: string) =>
  fixture({
    "package.json": JSON.stringify({ dependencies: { nuxt: "5.0.0-beta.2", vue: "3.5.18" } }),
    "node_modules/nuxt/package.json": JSON.stringify({
      name: "nuxt",
      version: "5.0.0-beta.2",
      dependencies: { nitro: "3.0.0-beta.4", vue: "3.5.18" },
    }),
    "node_modules/nuxt/node_modules/nitro/package.json": JSON.stringify({
      name: "nitro",
      version: "3.0.0-beta.4",
      dependencies: { h3: "2.0.8" },
    }),
    "node_modules/nuxt/node_modules/nitro/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: "2.0.8",
    }),
    "node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.18" }),
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "server/api/go.ts": handler,
  });

const hits = (result: DoctorRunResult) =>
  result.diagnostics
    .filter((item) => item.code === "H30011")
    .map((item) => ({ line: item.range?.line, why: item.message, fix: item.suggestion }));

test("reports response helpers whose result a handler drops", async () => {
  const root =
    h3Project(`import { H3, defineEventHandler, handleCors, html, proxy, redirect, sendRedirect } from "h3"
export const app = new H3()
  .get("/a", (event) => {
    if (!event.context.user) redirect("/login")
    return "ok"
  })
  .get("/b", async (event) => {
    await proxy(event, "https://example.com")
  })
  .get("/c", (event) => {
    event.context.ready && html("<p>ready</p>")
    sendRedirect(event, "/next")
  })
export const cors = defineEventHandler((event) => {
  handleCors(event, { origin: "*" })
  return "ok"
})
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result)).toEqual([
    {
      line: 4,
      why: expect.stringContaining("redirect()"),
      fix: expect.stringContaining('return redirect("/login")'),
    },
    {
      line: 8,
      why: expect.any(String),
      fix: expect.stringContaining('return proxy(event, "https://example.com")'),
    },
    { line: 11, why: expect.any(String), fix: expect.any(String) },
    { line: 12, why: expect.any(String), fix: expect.any(String) },
    {
      line: 15,
      why: expect.stringContaining("preflight"),
      fix: expect.stringContaining("cors !== false"),
    },
  ]);
});

test("reports a dropped auto-imported helper in a Nuxt server route", async () => {
  const root = nuxtProject(`export default defineEventHandler((event) => {
  noContent()
})
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result).map((item) => item.line)).toEqual([2]);
});

test("stays silent for returned helpers, used values, local helpers, h3 1.x, and non-handlers", async () => {
  const v2 = h3Project(`import { H3, handleCors, html, noContent, redirect, serveStatic } from "h3"
function later() {
  redirect("/login")
}
export const app = new H3()
  .get("/a", () => redirect("/login"))
  .get("/b", (event) => {
    const cors = handleCors(event, { origin: "*" })
    if (cors !== false) return cors
    return event.context.ok ? html("<p>ok</p>") : noContent()
  })
  .get("/c", (event) => {
    void Promise.resolve().then(() => redirect("/later"))
    return serveStatic(event, { getContents: () => "", getMeta: () => undefined })
  })
`);
  const local = h3Project(`import { H3 } from "h3"
const redirect = (to) => console.log(to)
export const app = new H3().get("/a", () => {
  redirect("/login")
  return "ok"
})
`);
  const v1 = h3Project(
    `import { createApp, defineEventHandler, handleCors, sendRedirect } from "h3"
export const app = createApp().use(
  defineEventHandler(async (event) => {
    handleCors(event, {})
    await sendRedirect(event, "/next")
  }),
)
`,
    "1.15.4",
  );
  for (const root of [v2, local, v1]) {
    const result = await runViteDoctor({ root, cache: false });
    expect(hits(result)).toEqual([]);
  }
});

test("reports legacy CORS guards that return no response", async () => {
  const root = h3Project(`import { H3, handleCors } from "h3"
export const app = new H3().use((event) => {
  if (handleCors(event, {})) return
  if (handleCors(event, {})) { return }
  const cors = handleCors(event, {})
  if (cors !== false) return cors
})
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result).map((item) => item.line)).toEqual([3, 4]);
});
