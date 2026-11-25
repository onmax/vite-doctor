import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { runViteDoctor, viteDoctorRulePacks } from "../../../src/doctor.ts";
import type { DoctorRunResult } from "../../../src/core/primitives.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-only-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const h3Manifest = (version: string) => JSON.stringify({ name: "h3", version });

const h3Project = (files: Record<string, string>, version = "2.0.8") =>
  fixture({
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { h3: version.startsWith("1.") ? "^1.15.0" : "^2.0.8", srvx: "^1.0.6" },
    }),
    "node_modules/h3/package.json": h3Manifest(version),
    ...files,
  });

const imports = `import {
  H3,
  createError,
  getHeader,
  getQuery,
  getRouterParams,
  readBody,
  send,
  sendRedirect,
  useBase,
} from "h3"
`;

const handlers = `
export const app = new H3()
  .get("/legacy", (event) => send(event, "ok"))
  .get("/go", (event) => sendRedirect(event, "/next"))
  .post("/items", async (event) => {
    if (event.req.method !== "POST") throw createError({ statusCode: 405 })
    const body = await readBody(event)
    return schema.parse(body)
  })
  .get("/search", (event) => {
    const query = getQuery(event)
    return schema.parse(query)
  })
  .get("/items/:id", (event) => {
    const params = getRouterParams(event)
    return schema.parse(params)
  })
  .get("/limited", (event) => {
    const ip = getHeader(event, "x-forwarded-for")
    return rateLimit(ip)
  })
  .get("/limited-v2", (event) => {
    const ip = event.req.headers.get("x-real-ip")
    return rateLimit(ip)
  })
  .post("/secure", async () => {
    try {
      throw createError({ statusCode: 401 })
    } catch {
      throw createError({ statusCode: 500 })
    }
  })

export const mounted = useBase("/api", app.handler)
`;

const server = imports + handlers;

const h3Codes = (result: DoctorRunResult, file = "src/server.ts") =>
  result.diagnostics
    .filter((item) => item.code.startsWith("H3") && item.file.endsWith(file))
    .map((item) => item.code)
    .sort();

test("an h3-only project activates the h3 Rule Pack and reports every moved rule", async () => {
  const root = h3Project({ "src/server.ts": server });

  const packs = await viteDoctorRulePacks({ root });
  expect(packs.map((pack) => pack.name)).toContain("vite-doctor/h3");

  const result = await runViteDoctor({ root, cache: false });
  expect(result.framework).not.toBe("nitro");
  expect(result.workspacePackages?.[0]?.rulePacks).toContain("vite-doctor/h3");
  expect(h3Codes(result)).toEqual([
    "H30001",
    "H30002",
    "H30003",
    "H30004",
    "H30005",
    "H30006",
    "H30006",
    "H30007",
    "H30008",
    "H30009",
  ]);
  const ip = result.diagnostics.find((item) => item.code === "H30006");
  expect(ip?.suggestion).toContain("trustProxy");
  expect(ip?.suggestion).not.toContain("xForwardedFor");
});

test("h3 utilities resolve through aliased and namespace imports", async () => {
  const root = h3Project({
    "src/server.ts": `import * as h3 from "h3"
import { getHeader as header } from "h3"
export const app = new h3.H3()
  .get("/a", (event) => rateLimit(header(event, "x-forwarded-for")))
  .get("/b", (event) => h3.sendRedirect(event, "/next"))
  .get("/c", (event) => { const query = h3.getQuery(event); return schema.parse(query) })
`,
  });

  const result = await runViteDoctor({ root, cache: false });
  expect(h3Codes(result)).toEqual(["H30002", "H30006", "H30008"]);
});

test("a locally defined utility with an h3 name stays silent", async () => {
  const root = h3Project({
    "src/server.ts": `import { H3 } from "h3"
const getHeader = (event, name) => event.req.headers.get(name.toUpperCase())
const readBody = async (event) => event.req.json()
const getQuery = (event) => Object.fromEntries(event.url.searchParams)
const getRouterParams = (event) => event.context.params
export const app = new H3()
  .post("/items", async (event) => {
    const body = await readBody(event)
    return schema.parse(body)
  })
  .get("/search", (event) => {
    const query = getQuery(event)
    return schema.parse(query)
  })
  .get("/items/:id", (event) => {
    const params = getRouterParams(event)
    return schema.parse(params)
  })
  .get("/limited", (event) => {
    const ip = getHeader(event, "x-forwarded-for")
    return rateLimit(ip)
  })
`,
  });

  const result = await runViteDoctor({ root, cache: false });
  expect(h3Codes(result)).toEqual([]);
});

test("an unimported createError outside Nitro and Nuxt is not treated as h3's", async () => {
  const root = h3Project({
    "src/server.ts": `import { H3 } from "h3"
export const app = new H3().post("/secure", async () => {
  try {
    throw createError({ statusCode: 401 })
  } catch {
    throw createError({ statusCode: 500 })
  }
})
`,
  });

  const result = await runViteDoctor({ root, cache: false });
  expect(h3Codes(result)).toEqual([]);
});

test("method guards outside h3 handlers stay silent", async () => {
  const root = h3Project({
    "src/server.ts": `import { H3, createError } from "h3"
export function guard(event) {
  if (event.req.method !== "POST") throw createError({ statusCode: 405 })
}
export const app = new H3().post("/items", (event) => {
  if (event.req.method !== "POST") throw createError({ statusCode: 405 })
  return "ok"
})
`,
  });

  const result = await runViteDoctor({ root, cache: false });
  expect(
    result.diagnostics.filter((item) => item.code === "H30005").map((item) => item.range?.line),
  ).toEqual([6]);
});

test("files with only type imports from h3, and test files, stay silent", async () => {
  const root = h3Project({
    "src/types.ts": `import type { H3Event } from "h3"
export function limited(event: H3Event) {
  const ip = getHeader(event, "x-forwarded-for")
  return rateLimit(ip)
}
export function read(event: H3Event) {
  const body = readBody(event)
  return schema.parse(body)
}
`,
    "src/server.test.ts": server,
  });

  const result = await runViteDoctor({ root, cache: false });
  expect(result.diagnostics.filter((item) => item.code.startsWith("H3"))).toEqual([]);
});

test("only workspace packages that run h3 get h3 diagnostics", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    "packages/api/package.json": JSON.stringify({
      name: "api",
      type: "module",
      dependencies: { h3: "^2.0.8", srvx: "^1.0.6" },
    }),
    "packages/api/node_modules/h3/package.json": h3Manifest("2.0.8"),
    "packages/api/src/server.ts": server,
    "packages/web/package.json": JSON.stringify({ name: "web", type: "module" }),
    "packages/web/src/server.ts": server,
  });

  const result = await runViteDoctor({ root, cache: false });
  expect(h3Codes(result, "packages/api/src/server.ts")).toContain("H30007");
  expect(h3Codes(result, "packages/web/src/server.ts")).toEqual([]);
});

test("an h3 1.x package keeps the rules that apply to h3 1.x", async () => {
  const root = h3Project({ "src/server.ts": server }, "1.15.4");

  const result = await runViteDoctor({ root, cache: false });
  expect(h3Codes(result)).toEqual([
    "H30004",
    "H30005",
    "H30006",
    "H30006",
    "H30007",
    "H30008",
    "H30009",
  ]);
  const ip = result.diagnostics.find((item) => item.code === "H30006");
  expect(ip?.suggestion).not.toContain("trustProxy");
});

test("server files follow the framework of the workspace package that owns them", async () => {
  const ipHandler = (wrap: string) =>
    `${wrap}((event) => rateLimit(getHeader(event, "x-forwarded-for")))\n`;
  const root = fixture({
    "package.json": JSON.stringify({
      name: "root",
      type: "module",
      workspaces: ["apps/*"],
      dependencies: { h3: "^2.0.8", srvx: "^1.0.6" },
    }),
    "node_modules/h3/package.json": h3Manifest("2.0.8"),
    "server/api/ip.ts": `import { H3 } from "h3"\nexport const app = new H3()\n${ipHandler("export default ")}`,
    "apps/web/package.json": JSON.stringify({
      name: "web",
      dependencies: { nuxt: "5.0.0-beta.2", vue: "3.5.18" },
    }),
    "apps/web/node_modules/nuxt/package.json": JSON.stringify({
      name: "nuxt",
      version: "5.0.0-beta.2",
      dependencies: { nitro: "3.0.0-beta.4", vue: "3.5.18" },
    }),
    "apps/web/node_modules/nuxt/node_modules/nitro/package.json": JSON.stringify({
      name: "nitro",
      version: "3.0.0-beta.4",
      dependencies: { h3: "2.0.0-rc.26" },
    }),
    "apps/web/node_modules/nuxt/node_modules/nitro/node_modules/h3/package.json":
      h3Manifest("2.0.0-rc.26"),
    "apps/web/node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.18" }),
    "apps/web/nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "apps/web/server/api/ip.ts": ipHandler("export default defineEventHandler"),
  });

  const result = await runViteDoctor({ root, cache: false });
  expect(h3Codes(result, "apps/web/server/api/ip.ts")).toEqual(["H30006"]);
  expect(
    result.diagnostics.filter(
      (item) => item.code.startsWith("H3") && item.file === join(root, "server/api/ip.ts"),
    ),
  ).toEqual([]);
});
