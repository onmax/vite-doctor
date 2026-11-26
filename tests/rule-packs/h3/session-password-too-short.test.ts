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
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-session-password-"));
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
    .filter((item) => item.code === "H30017")
    .map((item) => item.range?.line);
}

const secret = "a".repeat(32);

test("short literal session passwords are reported in h3 v2 and v1", async () => {
  const server = `import { H3, getSession, sealSession, useSession } from "h3"
const PASSWORD = "short-secret"
const config = { name: "app", password: \`also-short\` }
export const app = new H3()
  .get("/a", async (event) => (await useSession(event, { password: "changeme" })).data)
  .get("/b", (event) => getSession(event, { password: PASSWORD }))
  .get("/c", (event) => sealSession(event, config))
`;
  for (const version of ["2.0.8", "1.15.11"]) {
    const root = h3Project({ "src/server.ts": server }, version);
    expect(await lines(root)).toEqual([5, 7]);
  }
});

test("a Nitro server file with an auto-imported useSession is reported", async () => {
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
    "server/api/me.ts": `export default defineHandler(async (event) => {
  const session = await useSession(event, { password: "dev" })
  return session.data
})
`,
  });

  expect(await lines(root)).toEqual([2]);
});

test("long, runtime, custom-seal, and look-alike passwords stay silent", async () => {
  const root = h3Project({
    "src/server.ts": `import { H3, clearSession, updateSession, useSession as session } from "h3"
function useSession(event, config) { return config }
let mutable = "short"
const base = { password: "short" }
const config = { password: "short" }
config.password = process.env.SESSION_PASSWORD!
export const app = new H3()
  .get("/a", (event) => session(event, { password: "${secret}" }))
  .get("/b", (event) => session(event, { password: process.env.SESSION_PASSWORD! }))
  .get("/c", (event) => session(event, { password: "short", seal: { encryption: { minPasswordlength: 4 } } }))
  .get("/d", (event) => session(event, { ...base, password: "short" }))
  .get("/e", (event) => session(event, { password: mutable }))
  .get("/f", (event) => useSession(event, { password: "short" }))
  .get("/g", (event) => clearSession(event, { password: "short" }))
  .get("/h", (event) => updateSession(event, { password: { id: "1", secret: "short" } }))
  .get("/i", (event) => session(event, config))
  .get("/j", (event) => session(event, { password: "short", cookie: false, sessionHeader: false }))
  .get("/k", (event) => updateSession(event, { password: "short", cookie: false, sessionHeader: false }))
`,
  });

  expect(await lines(root)).toEqual([]);
});
