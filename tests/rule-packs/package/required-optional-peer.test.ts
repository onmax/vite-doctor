import { expect, test } from "vite-plus/test";
import { diagnose } from "./fixture.js";

const optionalPeer = {
  peerDependencies: { peer: "*" },
  peerDependenciesMeta: { peer: { optional: true } },
};

test.each([
  'await Promise.all([import("peer")]);',
  'await Promise.all([0, null, true, ("ready"), import("peer")]);',
  'await Promise.all([import("node:fs"), import("peer")]);',
  'export {}; await (Promise.all([(import("peer"))]));',

  '(function () { require("peer"); }).call(this);',
  '(function () { require("peer"); }).apply(this, []);',
  '((peer = require("peer")) => peer).call(null);',
  '((peer = require("peer")) => peer).apply(null, []);',
  '((peer = require("peer")) => peer).apply(null, [undefined]);',
  'require("peer")?.load();',
  'require("peer")?.["load"]();',
  'require("peer").load?.();',
  '(({ ["peer"]: peer = require("peer") }) => peer)({});',
  '(({ [1]: peer = require("peer") }) => peer)({});',
  '(({ toString = require("peer") }) => toString)({ toString: undefined });',
  '(({ peer = require("peer") }) => peer)({ ["peer"]: undefined });',
  'do { switch (1) { case 1: break; } } while (require("peer"));',
  'do { while (true) { break; } } while (require("peer"));',
  'do { inner: { break inner; } } while (require("peer"));',
  '((peer = require("peer")) => peer)(undefined);',
  '(({ peer = require("peer") } = {}) => peer)();',
  '(({ peer = require("peer") }) => peer)({});',
  '(({ nested: { peer = require("peer") } = {} } = {}) => peer)();',
  '(([peer = require("peer")] = []) => peer)();',

  'do { require("peer"); } while (false);',
  'do {} while (require("peer"));',
  'do { continue; } while (require("peer"));',
  '(function (peer = require("peer")) {})();',
  '((peer = require("peer")) => peer)();',
  '((unused, peer = require("peer")) => peer)(1);',
  '((peer = require("peer")) => peer)(void 0);',
  'export {}; await (import("peer"));',
  'export {}; await (((import("peer"))));',
  '(() => require("peer"))();',
  '(function () { require("peer"); })();',
  '((() => require("peer")))();',
  '(() => (() => require("peer"))())();',
  'try {} finally { require("peer"); }',
  'try {} catch {} finally { require("peer"); }',
  'try { require("peer"); } finally {}',
  'while (require("peer")) {}',
  'for (require("peer");;) {}',
  'for (;require("peer");) {}',
  'for (const item of require("peer")) {}',
  'for (const item in require("peer")) {}',
  'class Adapter extends require("peer").Base {}',
  'class Adapter { static peer = require("peer"); }',
  'class Adapter { static { require("peer"); } }',
  'class Adapter { [require("peer").key]() {} }',
  'class Adapter { [require("peer").key] = null; }',
  'import "peer";',
  'export * from "peer";',
  'const peer = require("peer/subpath");',
  'module.exports = require("peer");',
  'await import("peer");',
  'require("peer") || fallback;',
  'require("peer") && usePeer();',
  'require("peer") ?? fallback;',
  'require("peer").value ||= fallback;',
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
  'require = undefined; require?.("peer");',
  'require?.("peer");',
  'Promise.all([import("peer")]);',
  'await Promise.all([(() => { throw new Error("stop") })(), import("peer")]);',
  'await Promise.all([unknown, import("peer")]);',
  'await Promise.all([...values, import("peer")]);',
  'await Promise.allSettled([import("peer")]);',
  'const Promise = custom; await Promise.all([import("peer")]);',
  'try { await Promise.all([import("peer")]); } catch {}',
  'await Promise.all([enabled && import("peer")]);',
  'await Promise.all([() => import("peer")]);',
  'async function load() { await Promise.all([import("peer")]); }',

  '(({ toString = require("peer") }) => toString)({});',
  '(({ constructor = require("peer") }) => constructor)({});',
  '(({ ["toString"]: peer = require("peer") }) => peer)({});',
  '(({ ["peer"]: peer = require("peer") }) => peer)({ peer: 1 });',
  '(({ [1]: peer = require("peer") }) => peer)({ 1: 1 });',
  '(({ peer = require("peer") }) => peer)({ __proto__: custom });',
  '((peer = require("peer")) => peer).call(null, 1);',
  '((peer = require("peer")) => peer).apply(null, [1]);',
  '((peer = require("peer")) => peer).apply(null, unknown);',
  'obj?.[require("peer")];',
  'obj?.load?.(require("peer"));',
  '(function () { require("peer"); }).call?.(null);',
  'outer: do { do { continue outer; } while (require("peer")); } while (false);',
  'outer: do { switch (1) { case 1: break outer; } } while (require("peer"));',
  '((undefined) => ((peer = require("peer")) => peer)(undefined))(1);',
  'const undefined = 1; ((peer = require("peer")) => peer)(undefined);',
  '(({ peer = require("peer") } = {}) => peer)({ peer: 1 });',
  '(({ peer = require("peer") }) => peer)(unknown);',
  '(({ peer = require("peer") }) => peer)({ ...unknown });',
  '(([peer = require("peer")] = []) => peer)([1]);',
  'const load = () => require("peer");',
  '((peer = require("peer")) => peer)({});',
  'consume(() => require("peer"));',
  '((peer = require("peer")) => peer)(...args);',
  'if (enabled) ((peer = require("peer")) => peer)();',
  'do { if (enabled) break; } while (require("peer"));',
  '(function* () { require("peer"); })();',
  '(async () => { await ready; require("peer"); })();',
  'if (enabled) (() => require("peer"))();',
  'try { (() => require("peer"))(); } catch {}',
  '(() => { try { require("peer"); } catch {} })();',
  '(() => () => require("peer"))();',
  '(() => require("peer"))?.();',
  'try {} catch { require("peer"); }',
  'try { try {} finally { require("peer"); } } catch {}',
  'function load() { try {} finally { require("peer"); } }',
  'do { if (enabled) require("peer"); } while (false);',
  'do { break; } while (require("peer"));',
  '(import("peer")).catch(() => {});',
  'while (enabled) { require("peer"); }',
  'for (;enabled;require("peer")) {}',
  'for (const item of items) { require("peer"); }',
  'class Adapter { peer = require("peer"); }',
  'class Adapter { static load() { require("peer"); } }',
  'if (enabled) { class Adapter extends require("peer").Base {} }',
  'try { require("peer") } catch {}',
  'if (enabled) require("peer");',
  'const peer = enabled ? require("peer") : null;',
  'const peer = enabled && require("peer");',
  'const peer = enabled || require("peer");',
  'const peer = enabled ?? require("peer");',
  'peer ||= require("peer");',
  'peer &&= require("peer");',
  'peer ??= require("peer");',
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

test.each(["./cli.js", { example: "./cli.js" }, ["./cli.js"]])(
  "allows optional peers loaded only by standalone binaries: %j",
  async (bin) => {
    expect(
      await diagnose(
        { main: "index.js", bin, ...optionalPeer },
        {
          "index.js": "export {};",
          "cli.js": 'import "./adapter.js";',
          "adapter.js": 'import "peer";',
        },
      ),
    ).toEqual([]);
  },
);

test("still reports a binary also loaded by the default entrypoint", async () => {
  const diagnostics = await diagnose(
    { main: "index.js", bin: "cli.js", ...optionalPeer },
    { "index.js": 'import "./cli.js";', "cli.js": 'import "peer";' },
  );
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["PKG0003"]);
});

test("still diagnoses undeclared dependencies in standalone binaries", async () => {
  const diagnostics = await diagnose(
    { main: "index.js", bin: "cli.js" },
    { "index.js": "export {};", "cli.js": 'import "undeclared";' },
  );
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["PKG0001"]);
});

test("analyzes every array-form binary", async () => {
  const diagnostics = await diagnose(
    { bin: ["first.js", "second.js"] },
    { "first.js": 'import "first-peer";', "second.js": 'import "second-peer";' },
  );
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["PKG0001", "PKG0001"]);
});

test.each([
  { main: "./index.js" },
  { module: "./index.js" },
  { exports: { ".": "./index.js" } },
  {},
])("checks browser replacements of default entrypoints: %j", async (entrypoint) => {
  const diagnostics = await diagnose(
    {
      ...entrypoint,
      browser: { "./index.js": "./browser.js", "./integration.js": "./adapter.js" },
      ...optionalPeer,
    },
    {
      "index.js": "export {};",
      "browser.js": 'import "peer";',
      "integration.js": "export {};",
      "adapter.js": 'import "peer";',
    },
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.code).toBe("PKG0003");
  expect(diagnostics[0]?.file).toContain("browser.js");
});

test.each(['import "./server.js";', 'export const load = () => import("./server.js");'])(
  "propagates local import requiredness to browser replacements: %s",
  async (source) => {
    const diagnostics = await diagnose(
      { main: "index.js", browser: { "./server.js": "./browser.js" }, ...optionalPeer },
      {
        "index.js": source,
        "server.js": "export {};",
        "browser.js": 'import "peer";',
      },
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      source.startsWith("import") ? ["PKG0003"] : [],
    );
  },
);

test("does not execute local files passed to require.resolve", async () => {
  expect(
    await diagnose(
      { main: "index.js", ...optionalPeer },
      {
        "index.js": 'require.resolve("./adapter.js");',
        "adapter.js": 'import "peer";',
      },
    ),
  ).toEqual([]);
});

test("requires optional peers resolved directly", async () => {
  expect(
    await diagnose(
      { main: "index.js", ...optionalPeer },
      {
        "index.js": 'require.resolve("peer");',
      },
    ),
  ).toMatchObject([{ code: "PKG0003" }]);
});

test.each(["dist/index", "dist"])("resolves legacy main %s", async (main) => {
  expect(
    await diagnose(
      { main, ...optionalPeer },
      {
        "dist/index.js": 'require("peer");',
      },
    ),
  ).toHaveLength(1);
});

test.each([
  'class Adapter { @require("peer") method() {} }',
  'class Adapter { @require("peer") field = null; }',
  'class Adapter { method(@require("peer") value: unknown) {} }',
])("reports eager member decorators: %s", async (source) => {
  expect(
    await diagnose(
      { main: "index.ts", ...optionalPeer },
      {
        "index.ts": source,
      },
    ),
  ).toHaveLength(1);
});

test.each([
  'function load() { class Adapter { @require("peer") method() {} } }',
  'class Outer { load() { class Adapter { @require("peer") method() {} } } }',
  'class Adapter { @(() => require("peer")) method() {} }',
  'if (enabled) { class Adapter { @require("peer") method() {} } }',
])("preserves guarded decorator loads: %s", async (source) => {
  expect(
    await diagnose(
      { main: "index.ts", ...optionalPeer },
      {
        "index.ts": source,
      },
    ),
  ).toEqual([]);
});

test.each(["dist/index", "dist"])("probes module entrypoint %s", async (module) => {
  expect(
    await diagnose(
      { module, ...optionalPeer },
      {
        "dist/index.js": 'import "peer";',
      },
    ),
  ).toHaveLength(1);
});

test.each(["chunk", "chunk/index"])("prefers TypeScript source at %s", async (target) => {
  for (const required of [true, false]) {
    const diagnostics = await diagnose(
      { main: "index.ts", ...optionalPeer },
      {
        "index.ts": 'import "./chunk";',
        [`${target}.ts`]: required ? 'import "peer";' : "export {};",
        [`${target}.js`]: required ? "export {};" : 'import "peer";',
      },
    );
    expect(diagnostics).toHaveLength(required ? 1 : 0);
  }
});
