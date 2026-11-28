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
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-prepared-status-"));
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
    "server/routes/items.post.ts": handler,
  });

const hits = (result: DoctorRunResult) =>
  result.diagnostics
    .filter((item) => item.code === "H30012")
    .map((item) => ({ line: item.range?.line, why: item.message }));

test("reports a prepared status that a returned Response overrides", async () => {
  const root = h3Project(`import { H3, defineHandler, setResponseStatus } from "h3"
export const app = new H3()
  .post("/a", (event) => {
    event.res.status = 201
    const body = JSON.stringify({ ok: true })
    return new Response(body, { headers: { "content-type": "application/json" } })
  })
  .post("/b", async (event) => {
    setResponseStatus(event, 202, "Accepted")
    return Response.json({ queued: true })
  })
  .get("/c", (event) => {
    if (event.context.gone) {
      event.res.statusText = "Gone for good"
      return new Response(null, { status: 410 })
    }
    return "ok"
  })
export const created = defineHandler((event) => {
  event.res.status = 201
  return new Response("created")
})
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result)).toEqual([
    { line: 4, why: expect.stringContaining("own status, so the status prepared") },
    { line: 9, why: expect.stringContaining("status and statusText") },
    { line: 14, why: expect.stringContaining("own statusText") },
    { line: 20, why: expect.stringContaining("headers are still merged") },
  ]);
});

test("reports an auto-imported setResponseStatus in a Nitro route", async () => {
  const root = nitroProject(`export default defineHandler((event) => {
  setResponseStatus(event, 201)
  return new Response("created")
})
`);
  const result = await runViteDoctor({ root, cache: false });
  expect(hits(result).map((item) => item.line)).toEqual([2]);
});

test("stays silent when the status reaches the response or the code branches", async () => {
  const v2 = h3Project(`import { H3, setResponseStatus } from "h3"
export function helper(event) {
  event.res.status = 201
  return new Response("not a handler")
}
export const app = new H3()
  .post("/a", (event) => {
    event.res.status = 201
    return { ok: true }
  })
  .post("/b", (event) => {
    event.res.status = 201
    return new Response("ok", { status: 201 })
  })
  .post("/c", (event) => {
    event.res.status = 400
    if (!event.context.valid) return { error: "invalid" }
    return new Response("ok")
  })
  .post("/d", (event) => {
    if (event.context.created) event.res.status = 201
    return new Response("ok")
  })
  .post("/e", (event) => {
    setResponseStatus(event, 200)
    return new Response("ok")
  })
  .post("/f", (event, init) => {
    event.res.status = 201
    return new Response("ok", init)
  })
  .post("/g", (event) => {
    const other = { res: {} }
    other.res.status = 201
    return new Response("ok")
  })
`);
  const shadowed = h3Project(`import { H3 } from "h3"
import { Response } from "./response"
export const app = new H3().post("/a", (event) => {
  event.res.status = 201
  return new Response("ok")
})
`);
  const v1 = h3Project(
    `import { createApp, defineEventHandler, setResponseStatus } from "h3"
export const app = createApp().use(
  defineEventHandler((event) => {
    setResponseStatus(event, 201)
    return new Response("ok")
  }),
)
`,
    "1.15.4",
  );
  for (const root of [v2, shadowed, v1]) {
    const result = await runViteDoctor({ root, cache: false });
    expect(hits(result)).toEqual([]);
  }
});
