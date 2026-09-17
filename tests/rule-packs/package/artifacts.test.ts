import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import { readPackageArtifacts } from "../../../src/rule-packs/package/artifacts.js";

function inventory(manifest: object, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-artifacts-"));
  try {
    for (const [file, text] of Object.entries({
      "package.json": JSON.stringify(manifest),
      ...files,
    })) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return readPackageArtifacts(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("follows conditional exports, chunks and declarations without scanning source or unrelated output", () => {
  const result = inventory(
    {
      name: "example",
      exports: {
        ".": {
          import: "./dist/index.mjs",
          require: "./dist/index.cjs",
          types: "./dist/index.d.ts",
        },
        "./adapters/*": "./dist/adapters/*.js",
      },
    },
    {
      "dist/index.mjs": 'export * from "./chunk.mjs"; import "node:fs"; import "example/subpath";',
      "dist/chunk.mjs": 'import "h3";',
      "dist/index.cjs": 'module.exports = require("cjs-peer");',
      "dist/index.d.ts": 'export * from "./types.js";',
      "dist/types.d.ts": 'export type X = import("@babel/types").Node;',
      "dist/adapters/react.js": 'import "react";',
      "src/index.ts": 'import "bundled-away";',
      "dist/unused.js": 'import "unused";',
    },
  )!;
  expect(
    result.references
      .map((ref) => [ref.packageName, ref.kind, ref.required])
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual([
    ["@babel/types", "types", false],
    ["cjs-peer", "runtime", true],
    ["h3", "runtime", true],
    ["react", "runtime", false],
  ]);
});

test("resolves package imports and terminates cycles", () => {
  const result = inventory(
    {
      main: "dist/index.js",
      imports: {
        "#internal": "./dist/internal.js",
        "#peer/*": "@scope/peer/*",
        "#cycle": "#cycle",
      },
    },
    {
      "dist/index.js": 'import "#internal"; import "#peer/client"; import "#cycle";',
      "dist/internal.js": 'import "./index.js"; import "internal-peer";',
    },
  )!;
  expect(
    result.references
      .map((ref) => ref.packageName)
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual(["@scope/peer", "internal-peer"]);
});

test("does not confuse guarded and deferred loads with required entrypoint loads", () => {
  const result = inventory(
    { main: "index.js" },
    {
      "index.js": `try { require("guarded") } catch {};
function load() { return require("deferred") }
if (enabled) require("conditional");
const value = enabled && require("logical");
await import("awaited");
import("lazy").catch(() => {});
import("./adapter.js");
function custom(require) { require("shadowed") }`,
      "adapter.js": 'import "adapter-peer";',
    },
  )!;
  expect(result.references.filter((ref) => ref.required).map((ref) => ref.packageName)).toEqual([
    "awaited",
  ]);
  expect(result.references.map((ref) => ref.packageName)).not.toContain("shadowed");
  expect(result.references.find((ref) => ref.packageName === "adapter-peer")?.required).toBe(false);
});

test("records absent artifacts and skips private packages", () => {
  expect(inventory({ main: "dist/index.js" }, {})?.missing).toEqual(["dist/index.js"]);
  expect(
    inventory({ private: true, main: "index.js" }, { "index.js": 'import "peer"' }),
  ).toBeNull();
});

test("reads declaration references, import equals and re-exports", () => {
  const result = inventory(
    { types: "index.d.ts" },
    {
      "index.d.ts":
        '/// <reference types="node" />\nimport Foo = require("foo");\nexport { X } from "bar";',
    },
  )!;
  expect(
    result.references
      .map((ref) => [ref.packageName, ref.typeReference])
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual([
    ["bar", false],
    ["foo", false],
    ["node", true],
  ]);
});

test("marks unmatched output patterns as missing evidence", () => {
  expect(inventory({ exports: { "./*": "./dist/*.js" } }, {})?.missing).toEqual(["dist/*.js"]);
});

test("follows self-references through the export map", () => {
  const result = inventory(
    { name: "library", exports: { ".": "./index.js", "./adapter": "./adapter.js" } },
    {
      "index.js": 'export * from "library/adapter";',
      "adapter.js": 'import "peer";',
    },
  )!;
  expect(result.references).toHaveLength(1);
  expect(result.references[0]).toMatchObject({ packageName: "peer", required: true });
});

test("includes adjacent declarations, browser and binary entrypoints, and typesVersions", () => {
  const result = inventory(
    {
      main: "dist/index.mjs",
      browser: "dist/browser.js",
      bin: { tool: "dist/cli.cjs" },
      typesVersions: { "*": { "*": ["types/*.d.ts"] } },
    },
    {
      "dist/index.mjs": "export const ready = true;",
      "dist/index.d.mts": 'export type Value = import("adjacent-types").Value;',
      "dist/browser.js": 'import "browser-peer";',
      "dist/cli.cjs": 'require("cli-peer");',
      "types/legacy.d.ts": 'export type Value = import("legacy-types").Value;',
    },
  )!;
  expect(result.references.map((ref) => ref.packageName).sort()).toEqual([
    "adjacent-types",
    "browser-peer",
    "cli-peer",
    "legacy-types",
  ]);
  expect(result.missing).toEqual([]);
});
