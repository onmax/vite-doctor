import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.js";
import { diagnose, withPackage } from "./fixture.js";

const RULE = "package/no-condition-after-default";

async function shadowed(manifest: object, files: Record<string, string> = {}) {
  const diagnostics = await diagnose(manifest, files);
  return diagnostics.filter((diagnostic) => diagnostic.ruleId === RULE);
}

test("reports a subpath whose default comes before import, at the default key", async () => {
  const manifest = {
    exports: { ".": { default: "./dist/index.cjs", import: "./dist/index.mjs" } },
  };
  await withPackage(manifest, {}, async (root) => {
    const result = await runViteDoctor({
      root,
      framework: "vite",
      cache: false,
      extends: ["package/recommended"],
    });
    const diagnostics = result.diagnostics.filter((d) => d.ruleId === RULE);
    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic).toMatchObject({
      code: "PKG0009",
      file: join(root, "package.json"),
      confidence: "manifest-backed",
    });
    expect(diagnostic!.message).toContain('exports["."]');
    expect(diagnostic!.message).toContain('"import"');
    expect(diagnostic!.suggestion).toContain('Move "default" after "import"');
    const text = JSON.stringify({ name: "example-library", ...manifest });
    expect(text.slice(diagnostic!.range!.start, diagnostic!.range!.end)).toBe(
      '"default":"./dist/index.cjs"',
    );
    expect(
      diagnostic!.evidence?.map(({ kind, range }) => [kind, text.slice(range?.start, range?.end)]),
    ).toEqual([
      ["manifest", '"default":"./dist/index.cjs"'],
      ["manifest", '"import":"./dist/index.mjs"'],
    ]);
  });
});

test("reports conditions sugar and nested conditions under node, once per object", async () => {
  const diagnostics = await shadowed({
    exports: {
      ".": {
        node: { default: "./dist/node.cjs", require: "./dist/node.cjs", import: "./dist/node.mjs" },
        default: "./dist/index.js",
      },
      "./feature": { default: { default: "./dist/feature.js" }, browser: "./dist/browser.js" },
    },
  });
  expect(diagnostics.map((d) => d.message).sort()).toEqual([
    expect.stringContaining('exports["."]["node"] comes before "require", "import"'),
    expect.stringContaining('exports["./feature"] comes before "browser"'),
  ]);

  const sugar = await shadowed({ exports: { default: "./index.js", require: "./index.cjs" } });
  expect(sugar).toHaveLength(1);
  expect(sugar[0]!.message).toContain('"default" comes before "require"');
});

test("stays quiet when default is last, at any depth", async () => {
  expect(
    await shadowed({
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          node: {
            import: "./dist/node.mjs",
            require: "./dist/node.cjs",
            default: "./dist/node.js",
          },
          import: "./dist/index.mjs",
          default: "./dist/index.cjs",
        },
        "./package.json": "./package.json",
        "./utils/*": { import: "./dist/utils/*.mjs", default: "./dist/utils/*.cjs" },
      },
    }),
  ).toEqual([]);
});

test("stays quiet when default can fall through or only types follow it", async () => {
  expect(
    await shadowed({
      exports: {
        // An object without its own default resolves nothing when no condition matches.
        ".": { default: { import: "./dist/index.mjs" }, require: "./dist/index.cjs" },
        "./a": { default: [{ browser: "./dist/browser.js" }], import: "./dist/a.mjs" },
        // TypeScript reads "types" when "default" has no declaration next to it.
        "./b": { default: "./dist/b.js", types: "./dist/b.d.ts" },
      },
    }),
  ).toEqual([]);
});

test.each([[[]], [["./runtime.mjs"]], [[{ browser: "./browser.mjs" }, [null]]]])(
  "reports a terminal array default: %j",
  async (target) => {
    expect(await shadowed({ exports: { default: target, import: "./esm.mjs" } })).toHaveLength(1);
  },
);

test("finds conditions inside reachable array entries, including at the exports root", async () => {
  const reached = { default: "./runtime.mjs", import: "./esm.mjs" };
  const unreachable = { default: "./fallback.cjs", require: "./other.cjs" };
  const diagnostics = await shadowed({ exports: [null, [reached], unreachable] });
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    expect.stringContaining('exports[1][0] comes before "import"'),
  ]);
});

test("only visits array fallbacks reachable under the enclosing conditions", async () => {
  const fallback = { default: "./fallback.mjs", import: "./esm.mjs" };
  const diagnostics = await shadowed({
    exports: {
      ".": { import: [{ import: "./runtime.mjs" }, fallback] },
      "./custom": { custom: { import: [{ custom: "./runtime.mjs" }, fallback] } },
      "./conditional": { import: [{ browser: "./browser.mjs" }, fallback] },
    },
  });
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    expect.stringContaining('exports["./conditional"]["import"][1] comes before "import"'),
  ]);
});

test("uses enclosing conditions to determine whether a nested default can fall through", async () => {
  const diagnostics = await shadowed({
    exports: {
      import: [{ default: { import: "./runtime.mjs" }, import: "./esm.mjs" }],
    },
  });
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    expect.stringContaining('exports["import"][0] comes before "import"'),
  ]);
});

test("validates export pathnames separately from URL queries and fragments", async () => {
  const fallback = { default: "./fallback.mjs", import: "./esm.mjs" };
  const diagnostics = await shadowed({
    exports: {
      "./query": { ...fallback, default: "./runtime.mjs?mode=fast%2Fsafe" },
      "./fragment": { ...fallback, default: "./runtime.mjs#fast%5Csafe" },
      "./array": ["./runtime.mjs?mode=fast%2Fsafe", fallback],
      "./encoded-path": { ...fallback, default: "./fast%2Fsafe.mjs?mode=test" },
    },
  });
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    expect.stringContaining('exports["./query"] comes before "import"'),
    expect.stringContaining('exports["./fragment"] comes before "import"'),
  ]);
});

test("skips declaration branches but reports custom runtime conditions starting with types", async () => {
  const declarations = { default: "./fallback.js", import: "./public.d.mts" };
  const diagnostics = await shadowed({
    exports: {
      ".": { types: [declarations], "types@>=6": declarations, default: "./runtime.mjs" },
      "./feature": {
        default: "./runtime.mjs",
        "types@>=6": declarations,
        "typescript-browser": "./browser.mjs",
      },
    },
  });
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    expect.stringContaining('exports["./feature"] comes before "typescript-browser"'),
  ]);
});

test("stays quiet for private packages and invalid exports that mix subpaths and conditions", async () => {
  expect(
    await shadowed({
      private: true,
      exports: { ".": { default: "./a.js", import: "./a.mjs" } },
    }),
  ).toEqual([]);
  expect(
    await shadowed({ exports: { ".": "./a.js", default: "./b.js", import: "./b.mjs" } }),
  ).toEqual([]);
});
