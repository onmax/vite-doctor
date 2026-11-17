import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { diagnose } from "./fixture.js";

const optionalPeer = {
  peerDependencies: { peer: "*" },
  peerDependenciesMeta: { peer: { optional: true } },
};

const unguarded = (diagnostics: Awaited<ReturnType<typeof diagnose>>) =>
  diagnostics.filter((diagnostic) => diagnostic.ruleId === "package/optional-peer-import-in-try");

test.each([
  'export const load = () => import("peer");',
  'export async function load() { return await import("peer"); }',
  'export async function load() { try { await setup(); } catch {} return import("peer"); }',
  'export async function load() { try { return await run(() => import("peer")); } catch { return undefined; } }',
  'export async function load() { try { await setup(); } catch { return await import("peer"); } }',
  'export const load = () => import("peer").then((module) => module.default);',
  'export const load = () => import("peer/subpath");',
])("reports an optional peer import() that no try or .catch() guards: %s", async (source) => {
  const diagnostics = unguarded(
    await diagnose({ main: "index.js", ...optionalPeer }, { "index.js": source }),
  );
  expect(diagnostics).toMatchObject([{ code: "PKG0004" }]);
  expect(diagnostics[0]?.why).toContain('"." export');
  expect(diagnostics[0]?.diagnostic.fix).toContain("try");
});

test.each([
  'export async function load() { try { return await import("peer"); } finally { done(); } }',

  'export async function load() { try { return await import("peer"); } catch (error) { throw new Error("Install peer", { cause: error }); } }',
  'export async function load() { try { const { run } = await import("peer"); return run(); } catch { return undefined; } }',
  'export const load = () => import("peer").catch(() => undefined);',
  'export const load = () => import("peer").then((module) => module.default).catch(() => undefined);',
  'export const load = () => import("peer").then((module) => module.default, () => undefined);',
  "export const load = (name) => import(name);",
  'export const load = () => import("required-peer");',
  'export const load = () => import("./local.js");',
])("accepts a guarded or non-optional import(): %s", async (source) => {
  expect(
    unguarded(
      await diagnose(
        {
          main: "index.js",
          ...optionalPeer,
          peerDependencies: { peer: "*", "required-peer": "*" },
        },
        { "index.js": source, "local.js": "export {};" },
      ),
    ),
  ).toEqual([]);
});

test("reports optional dependencies imported without a guard", async () => {
  expect(
    unguarded(
      await diagnose(
        { main: "index.js", optionalDependencies: { native: "*" } },
        { "index.js": 'export const load = () => import("native");' },
      ),
    ),
  ).toMatchObject([{ code: "PKG0004" }]);
});

test("leaves unconditional loads of the optional peer to PKG0003", async () => {
  const diagnostics = await diagnose(
    { main: "index.mjs", ...optionalPeer },
    { "index.mjs": 'await import("peer");' },
  );
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["PKG0003"]);
});

test("accepts an import() of a peer the same module already loads unconditionally", async () => {
  expect(
    unguarded(
      await diagnose(
        { exports: { ".": "./index.js", "./adapter": "./adapter.js" }, ...optionalPeer },
        {
          "index.js": "export {};",
          "adapter.js": 'import "peer";\nexport const extra = () => import("peer/extra");',
        },
      ),
    ),
  ).toEqual([]);
});

test("names the export subpath and the chain through deferred local chunks", async () => {
  const diagnostics = unguarded(
    await diagnose(
      { exports: { ".": "./dist/index.js", "./forge": "./dist/forge.js" }, ...optionalPeer },
      {
        "dist/index.js": "export {};",
        "dist/forge.js": 'export const forge = () => import("./loader.js");',
        "dist/loader.js": '\nexport const loadPeer = () => import("peer");',
      },
    ),
  );
  expect(diagnostics).toMatchObject([{ code: "PKG0004", range: { line: 2 } }]);
  expect(diagnostics[0]?.file).toMatch(/dist\/loader\.js$/);
  expect(diagnostics[0]?.why).toContain('"./forge" export');
  expect(diagnostics[0]?.why).toContain('dist/forge.js:1 "./loader.js" → dist/loader.js:2 "peer"');
});

test("reports each import() once when several entries reach it", async () => {
  expect(
    unguarded(
      await diagnose(
        { exports: { ".": "./index.js", "./a": "./a.js" }, ...optionalPeer },
        {
          "index.js": 'export * from "./a.js";',
          "a.js": 'export const load = () => import("peer");',
        },
      ),
    ),
  ).toHaveLength(1);
});

test.each([
  [{ exports: { "./vite": "./plugin.js" } }, "export {};"],
  [{ exports: { "./cli": "./plugin.js" } }, "export {};"],
  [{ exports: { ".": "./plugin.js" } }, 'import "vite";'],
  [{ name: "@scope/cli", exports: { ".": "./plugin.js" } }, "export {};"],
])("skips build tooling that Node loads without a bundler: %j", async (manifest, prefix) => {
  expect(
    unguarded(
      await diagnose(
        { ...manifest, ...optionalPeer, peerDependencies: { peer: "*", vite: "*" } },
        { "plugin.js": `${prefix}\nexport const load = () => import("peer");` },
      ),
    ),
  ).toEqual([]);
});

test.each([
  ['try { return import("peer"); } catch {}', false],
  ['try { return await Promise.all([import("peer")]); } catch {}', false],
  ['try { return await import("peer").then(x => x); } catch {}', false],
  ['return import("peer").finally(cleanup).catch(handleMissing);', false],
  ['try { return await import("peer"); } finally { cleanup(); }', true],
  ['return (import("peer").catch)(handleMissing);', true],
  ['return import("peer").catch().catch(handleMissing);', true],
  ['return import("peer").catch();', true],
])("matches esbuild import resolution: %s", async (body, accepted) => {
  const { build } = createRequire(createRequire(import.meta.url).resolve("vite"))("esbuild");
  const source = `export async function load() { ${body} }`;
  const built = await build({
    stdin: { contents: source, resolveDir: tmpdir() },
    bundle: true,
    write: false,
    logLevel: "silent",
  }).then(
    () => true,
    () => false,
  );
  expect(built).toBe(accepted);
  expect(
    unguarded(await diagnose({ main: "index.js", ...optionalPeer }, { "index.js": source })),
  ).toHaveLength(accepted ? 0 : 1);
});

test("keeps optional loaders separate from required and tooling branches", async () => {
  expect(
    unguarded(
      await diagnose(
        { exports: { "./adapter": { import: "./esm.js", require: "./cjs.cjs" } }, ...optionalPeer },
        {
          "esm.js": 'export const load = () => import("peer");',
          "cjs.cjs": 'require("peer"); require("vite");',
        },
      ),
    ),
  ).toHaveLength(1);
});
