import { expect, test } from "vite-plus/test";
import { diagnose } from "./fixture.js";

const optionalPeer = {
  peerDependencies: { peer: "*" },
  peerDependenciesMeta: { peer: { optional: true } },
};

test.each([
  'import "peer";',
  'export * from "peer";',
  'const peer = require("peer/subpath");',
  'module.exports = require("peer");',
  'await import("peer");',
])("reports an optional peer required by the entrypoint: %s", async (source) => {
  const diagnostics = await diagnose(
    { main: "dist/index.js", ...optionalPeer },
    { "dist/index.js": source },
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    code: "PKG0003",
    ruleId: "package/no-required-optional-peer",
    range: { line: 1 },
    confidence: "manifest-backed",
  });
  expect(diagnostics[0]?.suggestion).toContain("required peer");
  expect(diagnostics[0]?.docs).toContain("/diagnostics/PKG0003");
});

test.each([
  'try { require("peer") } catch {}',
  'if (enabled) require("peer");',
  'const peer = enabled ? require("peer") : null;',
  'const peer = enabled && require("peer");',
  'export const load = () => require("peer");',
  'import("peer").catch(() => {});',
  'function load(require) { return require("peer") }',
  'const require = (name) => name; require("peer");',
  'obj?.load(require("peer"));',
])("does not claim a guarded, deferred, or shadowed load is required: %s", async (source) => {
  expect(await diagnose({ main: "index.js", ...optionalPeer }, { "index.js": source })).toEqual([]);
});

test("reports a require used to evaluate an if condition", async () => {
  const diagnostics = await diagnose(
    { main: "index.js", ...optionalPeer },
    { "index.js": 'if (require("peer")) {}' },
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.code).toBe("PKG0003");
});

test("follows required local chunks and deduplicates references reached by multiple paths", async () => {
  const diagnostics = await diagnose(
    { exports: { ".": "./dist/index.js", "./adapter": "./dist/adapter.js" }, ...optionalPeer },
    {
      "dist/index.js": 'export * from "./adapter.js"; import "./other.js";',
      "dist/adapter.js": 'import "peer";',
      "dist/other.js": 'import "./adapter.js";',
    },
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.file).toContain("dist/adapter.js");
});

test("allows integrations behind a dedicated subpath or deferred local import", async () => {
  expect(
    await diagnose(
      { exports: { ".": "./dist/index.js", "./adapter": "./dist/adapter.js" }, ...optionalPeer },
      {
        "dist/index.js": 'export const load = () => import("./adapter.js");',
        "dist/adapter.js": 'import "peer";',
      },
    ),
  ).toEqual([]);
});

test("ignores declaration-only references, required peers, and normally installed dependencies", async () => {
  expect(
    await diagnose(
      { types: "index.d.ts", ...optionalPeer },
      { "index.d.ts": 'export type Value = import("peer").Value;' },
    ),
  ).toEqual([]);
  expect(
    await diagnose(
      { main: "index.js", peerDependencies: { peer: "*" } },
      { "index.js": 'import "peer";' },
    ),
  ).toEqual([]);
  expect(
    await diagnose(
      { main: "index.js", ...optionalPeer, dependencies: { peer: "*" } },
      { "index.js": 'import "peer";' },
    ),
  ).toEqual([]);
});

test("checks conditional default exports and package import aliases", async () => {
  const diagnostics = await diagnose(
    {
      exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
      imports: { "#peer": "peer" },
      ...optionalPeer,
    },
    {
      "index.mjs": 'import "#peer";',
      "index.cjs": 'require("peer");',
    },
  );
  expect(diagnostics.map((d) => d.code)).toEqual(["PKG0003", "PKG0003"]);
});
