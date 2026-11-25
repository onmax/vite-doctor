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
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-double-body-"));
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
    .filter((item) => item.code === "H30016")
    .map((item) => ({ line: item.range?.line, why: item.message }));
}

const handlers = `import { H3, defineHandler, proxyRequest, readBody, readValidatedBody } from "h3"
export const app = new H3()
  .post("/a", async (event) => {
    const raw = await event.req.text()
    const body = await readBody(event)
    return { raw, body }
  })
  .post("/b", async (event) => {
    const body = await readValidatedBody(event, schema)
    await audit(body)
    return proxyRequest(event, "https://upstream.test")
  })
  .post("/c", async (event) => {
    const [a, b] = await Promise.all([readBody(event), event.req.json()])
    return { a, b }
  })
export const named = defineHandler(async (event) => {
  await readBody(event)
  return readBody(event)
})
`;

test("a second body read or a proxy after a read in an h3 v2 handler is reported", async () => {
  const root = h3Project({ "src/server.ts": handlers });

  expect((await hits(root)).map((item) => item.line)).toEqual([5, 11, 14, 19]);
});

test("a Nitro server file that reads the body twice is reported", async () => {
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
    "server/api/item.post.ts": `export default defineHandler(async (event) => {
  const body = await readBody(event)
  const form = await readFormData(event)
  return { body, form }
})
`,
  });

  expect((await hits(root)).map((item) => item.line)).toEqual([3]);
});

test("h3 1.x caches the parsed body, so it stays silent", async () => {
  const root = h3Project({ "src/server.ts": handlers }, "1.15.11");

  expect(await hits(root)).toEqual([]);
});

test("exclusive branches, clones, explicit proxy bodies, and other events stay silent", async () => {
  const root = h3Project({
    "src/server.ts": `import { H3, proxy, proxyRequest, readBody } from "h3"
async function readTwice(event) {
  const readBody = (input) => input
  readBody(event)
  return readBody(event)
}
export const app = new H3()
  .post("/a", async (event) => {
    if (event.req.headers.get("content-type") === "text/plain") {
      return event.req.text()
    } else {
      return readBody(event)
    }
  })
  .post("/b", async (event) => {
    if (await isForm(event)) return event.req.formData()
    return readBody(event)
  })
  .post("/c", async (event) => {
    const copy = await event.req.clone().text()
    const body = await readBody(event)
    return { copy, body }
  })
  .post("/d", async (event) => {
    const body = await event.req.text()
    return proxyRequest(event, "https://upstream.test", { fetchOptions: { body } })
  })
  .post("/e", async (event) => {
    await readBody(event)
    return proxy(event, "https://upstream.test")
  })
  .post("/f", async (event) => {
    switch (event.req.headers.get("content-type")) {
      case "text/plain":
        return event.req.text()
      default:
        return readBody(event)
    }
  })
  .post("/g", async (event) => {
    const body = await readBody(event)
    return body ?? readBody(event)
  })
`,
  });

  expect(await hits(root)).toEqual([]);
});
