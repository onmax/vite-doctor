import { expect, test } from "vite-plus/test";
import { diagnose } from "./fixture.js";

const optionalPeer = {
  peerDependencies: { peer: "*" },
  peerDependenciesMeta: { peer: { optional: true } },
};

test.each([
  'try {} catch (Promise) {} await Promise.all([import("peer")]);',
  'for (let Promise of []) {} await Promise.all([import("peer")]);',
  'for (let Promise = 0; false;) {} await Promise.all([import("peer")]);',

  'while (true) { try { break; } finally { if (enabled) continue; } } require("peer");',
  'while (true) { try { continue; } finally { break; } } require("peer");',
  'await import("peer").finally(() => cleanup());',
  'await import("peer").then(value => value).finally(() => cleanup());',
  'await import("peer").finally(() => cleanup()).then(value => value);',
  'while (true) { break; } require("peer");',
  'do { break; } while (true); require("peer");',
  'for (;;) { if (enabled) break; } require("peer");',
  'while (enabled) {} require("peer");',
  'for (; false;) {} require("peer");',
  'outer: while (true) { while (true) { break outer; } } require("peer");',
  'await import("peer").then(value => value, {});',
  'await import("peer").then(value => value, []);',
  'await import("peer").then(value => value, ({ value: [0, null, () => {}] }));',
  'await import("peer").then(value => value, [, {}]);',
  '(function () { try { throw 0; } catch {} require("peer"); })();',
  '(function () { (() => { return; })(); require("peer"); })();',

  'new (class { peer = require("peer"); })();',
  'new (class { first = 0; peer = require("peer"); constructor() { return {}; } })();',
  'await import("peer").then(value => value, undefined);',
  'await import("peer").then(value => value, null);',
  'await import("peer").then(value => value, 0);',

  'new (class { field; constructor() { require("peer"); } })();',
  'new (class { field = 0; constructor() { require("peer"); } })();',
  'await import("peer").then(module => module.default);',
  'await import("peer").then().then(module => module.default);',
  'await import("peer").catch();',
  'await import("peer").catch(undefined);',
  'await import("peer").catch(null).finally(() => cleanup());',
  '(function (first = 0) { require("peer"); })();',
  '(function (first = 0) { require("peer"); }).call(null);',
  '(function (first = 0) { require("peer"); }).apply(null, []);',

  'new (function () { require("peer"); })();',
  'new (function () { require("peer"); });',
  'new (function (peer = require("peer")) {})();',
  'new (class { constructor() { require("peer"); } })();',
  'new (class { constructor(peer = require("peer")) {} })();',
  '(function () { try { require("peer"); } finally { (() => { return; })(); } })();',

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
  '(function () { while (true) {} require("peer"); })();',
  'while ((true)) {} require("peer");',
  'do {} while (true); require("peer");',
  'for (;;) {} require("peer");',
  'for (; true;) {} require("peer");',
  'while (true) { try { break; } finally { continue; } } require("peer");',
  'for (;;) { try { break; } finally { continue; } } require("peer");',
  'do { try { break; } finally { continue; } } while (true); require("peer");',
  'while (true) { try { break; } finally { if (enabled) continue; else continue; } } require("peer");',
  'import("peer").finally(() => cleanup());',
  'await import("peer").finally(() => cleanup()).catch(() => null);',
  'await import("peer").catch(() => null).finally(() => cleanup());',
  'try { await import("peer").finally(() => cleanup()); } catch {}',
  'while (true) { continue; } require("peer");',
  'while (true) { while (enabled) { break; } } require("peer");',
  'await import("peer").then(value => value, { value: unknown() });',
  'await import("peer").then(value => value, [unknown()]);',
  'await import("peer").then(value => value, { ...unknown });',
  'await import("peer").then(value => value, [...unknown]);',
  '(function () { if (disabled) return; require("peer"); })();',
  '(function () { { if (disabled) return; } require("peer"); })();',
  '(async function () { if (disabled) return; await import("peer"); })();',
  '(function () { return; require("peer"); })();',
  '(function () { { return; } require("peer"); })();',
  '(function () { throw 0; require("peer"); })();',
  'new (class { first = unknown(); peer = require("peer"); })();',
  'new (class extends Base { peer = require("peer"); })();',
  'if (enabled) new (class { peer = require("peer"); })();',
  'const undefined = () => {}; await import("peer").then(value => value, undefined);',
  '(function (first = (() => { throw 0; })()) { require("peer"); })();',
  '(function (first = (() => { throw 0; })()) { require("peer"); }).call(null);',
  '(function (first = (() => { throw 0; })()) { require("peer"); }).apply(null, []);',
  '(function (first = (() => { throw 0; })()) { require("peer"); }).apply(null, [,]);',
  '(function () { require("peer"); })((() => { throw 0; })());',
  '(function () { require("peer"); }).call(null, (() => { throw 0; })());',
  '(function () { require("peer"); }).apply(null, [(() => { throw 0; })()]);',
  '(function (first = (() => { throw 0; })(), peer = require("peer")) {})();',
  'import("peer").then(module => module.default);',
  'await import("peer").then(module => module.default, () => null);',
  'await import("peer").then(module => module.default).catch(() => null);',
  'await import("peer").catch(() => null);',
  'try { await import("peer").then(module => module.default); } catch {}',
  '(function () { try { require("peer"); } finally { return; } })();',
  '(function () { try { require("peer"); } finally { if (enabled) return; } })();',
  'new (function () { require("peer"); })((() => { throw 0; })());',
  'new (function (first = (() => { throw 0; })(), peer = require("peer")) {})();',
  'new (class { static { throw 0; } constructor() { require("peer"); } })();',
  'new (class { field = (() => { throw 0; })(); constructor() { require("peer"); } })();',
  'new (function (peer = require("peer")) {})(1);',
  'new (class { constructor(peer = require("peer")) {} })(1);',
  'const Adapter = class { constructor() { require("peer"); } };',
  'function deferred() { new (class { constructor() { require("peer"); } })(); }',
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

test.each(["chunk", "chunk/index"])(
  "skips explicit module-kind extensions at %s",
  async (target) => {
    for (const extension of ["mts", "cts"]) {
      for (const required of [true, false]) {
        expect(
          await diagnose(
            { main: "index.ts", ...optionalPeer },
            {
              "index.ts": 'import "./chunk";',
              [`${target}.${extension}`]: required ? "export {};" : 'import "peer";',
              [`${target}.js`]: required ? 'import "peer";' : "export {};",
            },
          ),
        ).toHaveLength(required ? 1 : 0);
      }
    }
  },
);

test("prefers TSX when substituting a JSX import", async () => {
  for (const required of [true, false]) {
    expect(
      await diagnose(
        { main: "index.ts", ...optionalPeer },
        {
          "index.ts": 'import "./chunk.jsx";',
          "chunk.tsx": required ? 'import "peer";' : "export {};",
          "chunk.ts": required ? "export {};" : 'import "peer";',
        },
      ),
    ).toHaveLength(required ? 1 : 0);
  }
});

test.each(["peer", "./types.d.ts", "#nested"])(
  "ignores type-only import-map target %s",
  async (target) => {
    expect(
      await diagnose(
        {
          main: "index.js",
          imports: { "#adapter": { types: target, default: "./adapter.js" }, "#nested": "peer" },
          ...optionalPeer,
        },
        {
          "index.js": 'import "#adapter";',
          "adapter.js": "export {};",
          "types.d.ts": 'import "peer";',
        },
      ),
    ).toEqual([]);
  },
);

test.each([
  ["./adapter.js", "peer"],
  [null, "./adapter.js", "peer"],
  [["./adapter.js", "peer"], "peer"],
])("uses the first valid imports array target: %j", async (...targets) => {
  expect(
    await diagnose(
      { main: "index.js", imports: { "#adapter": targets }, ...optionalPeer },
      { "index.js": 'import "#adapter";', "adapter.js": "export {};" },
    ),
  ).toEqual([]);
});

test("reports an optional peer required through a CommonJS directory main", async () => {
  const diagnostics = await diagnose(
    { main: "index.cjs", ...optionalPeer },
    {
      "index.cjs": 'require("./adapter");',
      "adapter/package.json": JSON.stringify({ main: "lib/index.js" }),
      "adapter/lib/index.js": 'require("peer");',
    },
  );
  expect(diagnostics).toMatchObject([{ code: "PKG0003" }]);
});

test.each(["const", "var", "function"])("keeps namespace %s bindings local", async (kind) => {
  const binding = kind === "function" ? "function Promise() {}" : `${kind} Promise = custom;`;
  for (const inside of [false, true]) {
    const load = 'await Promise.all([import("peer")]);';
    const source = `namespace Internal { ${binding} ${inside ? load : ""} } ${inside ? "" : load}`;
    expect(
      await diagnose({ main: "index.ts", ...optionalPeer }, { "index.ts": source }),
    ).toHaveLength(inside ? 0 : 1);
  }
});

test.each([{ node: [{ browser: "peer" }] }, { node: [[{ browser: "peer" }]] }])(
  "falls through unresolved import-map arrays: %j",
  async ({ node }) => {
    const diagnostics = await diagnose(
      {
        main: "index.js",
        imports: { "#adapter": { node, default: "./adapter.js" } },
        ...optionalPeer,
      },
      { "index.js": 'import "#adapter";', "adapter.js": 'import "peer";' },
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["PKG0003"]);
  },
);

test.each([{ node: [] }, { node: [null] }, { node: [{ browser: "peer" }, null] }])(
  "preserves blocked import-map arrays: %j",
  async ({ node }) => {
    expect(
      await diagnose(
        { main: "index.js", imports: { "#adapter": { node, default: "peer" } }, ...optionalPeer },
        { "index.js": 'import "#adapter";' },
      ),
    ).toEqual([]);
  },
);

test.each(["node-addons", "module-sync"])(
  "uses the fallback without evidence for runtime-dependent condition %s",
  async (condition) => {
    for (const source of ['import "#adapter";', 'require("#adapter");']) {
      expect(
        await diagnose(
          {
            main: "index.js",
            imports: { "#adapter": { [condition]: "peer", default: "./safe.js" } },
            ...optionalPeer,
          },
          { "index.js": source, "safe.js": "export {};" },
        ),
      ).toEqual([]);
    }
  },
);

test.each([
  'await (() => import("peer"))();',
  'await (async () => import("peer"))();',
  'await (() => { return import("peer"); })();',
  'await (async () => { await import("peer"); })();',
  'await (async () => { const value = 1; await import("peer"); })();',
])("follows an awaited immediate invocation: %s", async (source) => {
  expect(
    await diagnose({ main: "index.mjs", ...optionalPeer }, { "index.mjs": source }),
  ).toMatchObject([{ code: "PKG0003" }]);
});

test.each([
  'await (async () => { await mayReject(); await import("peer"); })();',
  'await (async () => { unknown(); await import("peer"); })();',
  'await (async () => { const value = unknown(); await import("peer"); })();',
])("skips unreachable loads after potentially abrupt operations: %s", async (source) => {
  expect(await diagnose({ main: "index.mjs", ...optionalPeer }, { "index.mjs": source })).toEqual(
    [],
  );
});

test.each([
  '(() => import("peer"))();',
  'await (() => { import("peer"); })();',
  '(() => { return import("peer"); })();',
  '(async () => { await import("peer"); })();',
])("keeps unawaited immediate loads deferred: %s", async (source) => {
  expect(await diagnose({ main: "index.mjs", ...optionalPeer }, { "index.mjs": source })).toEqual(
    [],
  );
});

test("skips invalid self-export array targets", async () => {
  expect(
    await diagnose(
      {
        name: "fixture",
        exports: { ".": "./index.js", "./adapter": ["../invalid.js", "./adapter.js"] },
        ...optionalPeer,
      },
      { "index.js": 'import "fixture/adapter";', "adapter.js": 'import "peer";' },
    ),
  ).toMatchObject([{ code: "PKG0003" }]);
});

test.each([
  ["index.mjs", undefined],
  ["index.js", "module"],
  ["index.cjs", "module"],
])("classifies module.require by format: %s (%s)", async (entry, type) => {
  expect(
    await diagnose(
      { main: entry, ...(type && { type }), ...optionalPeer },
      { [entry]: 'module.require("peer");' },
    ),
  ).toHaveLength(entry.endsWith(".cjs") ? 1 : 0);
});

test.each([
  ["index.mjs", undefined],
  ["index.js", "module"],
  ["index.cjs", "module"],
])("classifies bare require by format: %s (%s)", async (entry, type) => {
  expect(
    await diagnose(
      { main: entry, ...(type && { type }), ...optionalPeer },
      { [entry]: 'require("peer");' },
    ),
  ).toHaveLength(entry.endsWith(".cjs") ? 1 : 0);
});

test("uses the nearest package type for module.require", async () => {
  expect(
    await diagnose(
      { main: "dist/index.js", ...optionalPeer },
      {
        "dist/package.json": JSON.stringify({ type: "module" }),
        "dist/index.js": 'module.require("peer");',
      },
    ),
  ).toEqual([]);
});

test.each([
  ['(function require(peer = require("peer")) {})()', 0],
  ['(function require() { require("peer"); })()', 0],
  ['(function require() {})(); require("peer");', 1],
  ['module.require("peer");', 1],
  ['const module = { require() {} }; module.require("peer");', 0],
  [
    'const Adapter = class module { static require() {} static peer = module.require("peer"); };',
    0,
  ],
  ['(function module() { module.require("peer"); })()', 0],
  ['try { module.require("peer"); } catch {}', 0],
  ['function later() { module.require("peer"); }', 0],
  ['(function () { if (false) return; require("peer"); })()', 1],
  ['(function () { if (true) {} else return; require("peer"); })()', 1],
  ['(function () { if (enabled) return; require("peer"); })()', 0],
  ['(function () { if (true) return; require("peer"); })()', 0],
  ['(function () { while (false) { return; } require("peer"); })()', 1],
])("classifies required CommonJS loads: %s", async (source, count) => {
  expect(
    await diagnose({ main: "index.cjs", ...optionalPeer }, { "index.cjs": source }),
  ).toHaveLength(count);
});
