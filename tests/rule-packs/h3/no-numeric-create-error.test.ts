import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-numeric-error-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const h3Project = (files: Record<string, string>, version = "2.0.8") =>
  fixture({
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { h3: version.startsWith("1.") ? "^1.15.0" : "^2.0.8" },
    }),
    "node_modules/h3/package.json": JSON.stringify({ name: "h3", version }),
    ...files,
  });

async function hits(root: string) {
  const result = await runViteDoctor({ root, cache: false });
  return result.diagnostics
    .filter((item) => item.code === "H30014")
    .map((item) => ({ line: item.range?.line, fix: item.suggestion }));
}

test("numeric createError() and new HTTPError() in an h3 app are reported", async () => {
  const root = h3Project({
    "src/server.ts": `import { H3, HTTPError, createError } from "h3"
const NOT_FOUND = 404
export const app = new H3()
  .get("/a", () => { throw createError(404) })
  .get("/b", () => { throw new HTTPError(401) })
  .get("/c", () => { throw createError(NOT_FOUND, "missing") })
`,
  });

  const found = await hits(root);
  expect(found.map((item) => item.line)).toEqual([4, 5, 6]);
  expect(found[0]?.fix).toContain("createError({ status: 404 })");
  expect(found[1]?.fix).toContain("HTTPError.status(401)");
});

test("h3 1.x suggests statusCode", async () => {
  const root = h3Project(
    {
      "src/server.ts": `import { createApp, createError, eventHandler } from "h3"
export const app = createApp().use(eventHandler(() => { throw createError(403) }))
`,
    },
    "1.15.11",
  );

  const found = await hits(root);
  expect(found).toHaveLength(1);
  expect(found[0]?.fix).toContain("createError({ statusCode: 403 })");
});

test("a Nitro server file with an auto-imported createError is reported", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ dependencies: { nitro: "3.0.0-beta.4" } }),
    "node_modules/nitro/package.json": JSON.stringify({
      name: "nitro",
      version: "3.0.0-beta.4",
      dependencies: { h3: "2.0.0-rc.26" },
    }),
    "node_modules/nitro/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: "2.0.0-rc.26",
    }),
    "server/api/item.ts": `export default defineHandler(() => { throw createError(404) })\n`,
  });

  expect((await hits(root)).map((item) => item.line)).toEqual([1]);
});

test("object, string, and dynamic arguments and look-alike functions stay silent", async () => {
  const root = h3Project({
    "src/server.ts": `import { H3, HTTPError, createError as h3Error } from "h3"
function createError(status: number) { return new Error(String(status)) }
class Problem { constructor(readonly status: number) {} }
let status = 404
export const app = new H3()
  .get("/a", () => { throw h3Error({ status: 404 }) })
  .get("/b", () => { throw new HTTPError("Not found", { status: 404 }) })
  .get("/c", () => { throw HTTPError.status(404) })
  .get("/d", () => { throw h3Error(status) })
  .get("/e", () => { throw createError(404) })
  .get("/f", () => { throw new Problem(404) })
`,
  });

  expect(await hits(root)).toEqual([]);
});
