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
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-throw-object-"));
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

async function lines(root: string) {
  const result = await runViteDoctor({ root, cache: false });
  return result.diagnostics
    .filter((item) => item.code === "H30015")
    .map((item) => item.range?.line);
}

const handlers = `import { H3, defineHandler } from "h3"
export const app = new H3()
  .get("/a", () => { throw { statusCode: 404, message: "Not found" } })
  .get("/b", async (event) => {
    try {
      await load(event)
      throw { status: 403 }
    } catch (error) {
      throw error
    }
  })
export const named = defineHandler(() => {
  throw { "status": 400 }
})
`;

test("plain status objects thrown from h3 v2 handlers are reported", async () => {
  const root = h3Project({ "src/server.ts": handlers });

  expect(await lines(root)).toEqual([3, 7, 13]);
});

test("a Nuxt server route that throws a plain status object is reported", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ dependencies: { nuxt: "5.0.0-beta.2", vue: "3.5.18" } }),
    "node_modules/nuxt/package.json": JSON.stringify({
      name: "nuxt",
      version: "5.0.0-beta.2",
      dependencies: { nitro: "3.0.0-beta.4", vue: "3.5.18" },
    }),
    "node_modules/nuxt/node_modules/nitro/package.json": JSON.stringify({
      name: "nitro",
      version: "3.0.0-beta.4",
      dependencies: { h3: "2.0.0-rc.26" },
    }),
    "node_modules/nuxt/node_modules/nitro/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: "2.0.0-rc.26",
    }),
    "node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.18" }),
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "server/api/item.ts": `export default defineEventHandler(() => {
  throw { statusCode: 404 }
})
`,
  });

  expect(await lines(root)).toEqual([2]);
});

test("h3 1.x passes thrown objects through createError, so it stays silent", async () => {
  const root = h3Project(
    {
      "src/server.ts": `import { createApp, eventHandler } from "h3"
export const app = createApp().use(eventHandler(() => { throw { statusCode: 404 } }))
`,
    },
    "1.15.11",
  );

  expect(await lines(root)).toEqual([]);
});

test("caught throws, helpers, nested callbacks, and other objects stay silent", async () => {
  const root = h3Project({
    "src/server.ts": `import { H3, HTTPError } from "h3"
function fail() { throw { statusCode: 404 } }
export const app = new H3()
  .get("/a", () => {
    try {
      throw { status: 400 }
    } catch (error) {
      return { error }
    }
  })
  .get("/b", () => {
    try {
      throw { status: 400 }
    } catch {}
  })
  .get("/c", () => { throw new HTTPError({ status: 404 }) })
  .get("/d", () => { throw { code: "E_MISSING" } })
  .get("/e", () => { setTimeout(() => { throw { statusCode: 500 } }) })
`,
  });

  expect(await lines(root)).toEqual([]);
});
