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
        // Arrays fall back through their entries.
        "./a": { default: ["./dist/a.js"], import: "./dist/a.mjs" },
        // TypeScript reads "types" when "default" has no declaration next to it.
        "./b": { default: "./dist/b.js", types: "./dist/b.d.ts" },
      },
    }),
  ).toEqual([]);
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
