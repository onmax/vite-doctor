import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.js";
import { diagnose, withPackage } from "./fixture.js";

test("reports runtime and declaration phantoms with distinct codes and artifact locations", async () => {
  const diagnostics = await diagnose(
    {
      main: "dist/index.js",
      types: "dist/index.d.ts",
      devDependencies: { h3: "*", "@babel/types": "*" },
    },
    {
      "dist/index.js": 'import "h3";',
      "dist/index.d.ts": 'export type { Node } from "@babel/types";',
      "src/index.ts": 'import "bundled-away";',
    },
  );
  expect(diagnostics.map((d) => d.code).sort()).toEqual(["PKG0001", "PKG0002"]);
  for (const diagnostic of diagnostics) {
    expect(diagnostic.file).toContain("/dist/");
    expect(diagnostic.range?.line).toBe(1);
    expect(diagnostic.suggestion).toBeTruthy();
    expect(diagnostic.confidence).toBe("manifest-backed");
    expect(diagnostic.docs).toContain(`/diagnostics/${diagnostic.code}`);
    expect(diagnostic.sources?.[0]).toContain(diagnostic.file);
  }
});

test("accepts direct consumer declarations, optional peers, built-ins and self references", async () => {
  expect(
    await diagnose(
      {
        main: "dist/index.js",
        dependencies: { direct: "*" },
        peerDependencies: { peer: "*" },
        peerDependenciesMeta: { peer: { optional: true } },
        optionalDependencies: { optional: "*" },
      },
      {
        "dist/index.js":
          'import "direct/subpath"; import "peer"; try { require("optional") } catch {}; import "node:fs"; import "fs/promises"; import "example-library/subpath";',
      },
      { config: { rules: { "package/no-required-optional-peer": "off" } } },
    ),
  ).toEqual([]);
});

test("reports a guarded phantom without claiming it must become a required dependency", async () => {
  const diagnostics = await diagnose(
    { main: "index.js" },
    { "index.js": 'try { require("integration") } catch {}' },
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.suggestion).toContain("optional peer");
});

test("resolves type references and accepts declared @types providers", async () => {
  const files = {
    "index.d.ts":
      '/// <reference types="node" />\n/// <reference types="@scope/tool" />\nexport {};',
  };
  const diagnostics = await diagnose({ types: "index.d.ts" }, files);
  expect(diagnostics.map((d) => d.code)).toEqual(["PKG0002", "PKG0002"]);
  expect(
    await diagnose(
      { types: "index.d.ts", dependencies: { "@types/node": "*", "@types/scope__tool": "*" } },
      files,
    ),
  ).toEqual([]);
});

test("follows external import mappings and re-exported declaration chunks", async () => {
  const diagnostics = await diagnose(
    {
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.mts" } },
      imports: { "#adapter": "adapter" },
    },
    {
      "dist/index.js": 'export * from "#adapter";',
      "dist/index.d.mts": 'export * from "./chunk.mjs";',
      "dist/chunk.d.mts": 'export type Value = import("types-only").Value;',
      "dist/not-exported.js": 'import "unused";',
    },
  );
  expect(diagnostics.map((d) => d.code).sort()).toEqual(["PKG0001", "PKG0002"]);
});

test("does not trust a workspace root or node_modules as the package's declaration", async () => {
  const diagnostics = await diagnose(
    { main: "index.js" },
    {
      "index.js": 'import "installed";',
      "node_modules/installed/package.json": '{ "name": "installed", "version": "1.0.0" }',
    },
  );
  expect(diagnostics).toHaveLength(1);
});

test("accepts an @types provider for an external declaration import", async () => {
  expect(
    await diagnose(
      { types: "index.d.ts", dependencies: { "@types/foo": "*" } },
      { "index.d.ts": 'export type { Foo } from "foo";' },
    ),
  ).toEqual([]);
});

test("ignores JSDoc imports in JavaScript shadowed by published declarations", async () => {
  const files = {
    "dist/index.js": 'export { walk } from "./chunk.js";',
    "dist/chunk.js": [
      '/** @typedef { import("estree").BaseNode } BaseNode */',
      '/** @param {import("./walker.js").Walker} walker */',
      "export function walk(walker) { return walker; }",
    ].join("\n"),
  };
  const declared = await withPackage(
    { main: "dist/index.js", types: "dist/index.d.ts" },
    { ...files, "dist/index.d.ts": "export declare function walk(walker: unknown): unknown;" },
    (root) =>
      runViteDoctor({ root, framework: "vite", cache: false, extends: ["package/recommended"] }),
  );
  expect(declared.diagnostics.filter((d) => d.ruleId.startsWith("package/"))).toEqual([]);
  expect(declared.project.evidenceGaps ?? []).toEqual([]);
  const javascriptOnly = await diagnose({ main: "dist/index.js" }, files);
  expect(javascriptOnly.map((d) => [d.code, d.message.match(/"([^"]+)"/)?.[1]])).toEqual([
    ["PKG0002", "estree"],
  ]);
});

test("keeps JSDoc for JavaScript-only export subpaths", async () => {
  const diagnostics = await diagnose(
    {
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
        "./js-only": "./dist/js-only.js",
      },
    },
    {
      "dist/index.js": "export const value = 1;",
      "dist/index.d.ts": "export declare const value: number;",
      "dist/js-only.js":
        '/** @param {import("phantom-types").Value} value */\nexport function use(value) { return value; }',
    },
  );
  expect(diagnostics.map((d) => [d.code, d.message.match(/"([^"]+)"/)?.[1]])).toEqual([
    ["PKG0002", "phantom-types"],
  ]);
});

test.each<{ name: string; manifest: object; files: Record<string, string>; entry?: string }>([
  {
    name: "a types field outside the JavaScript directory",
    manifest: { main: "dist/index.js", types: "types/index.d.ts" },
    files: { "types/index.d.ts": "export declare const value: number;" },
  },
  {
    name: "an export types condition outside the JavaScript directory",
    manifest: {
      exports: { ".": { types: "./types/index.d.ts", import: "./dist/index.js" } },
    },
    files: { "types/index.d.ts": "export declare const value: number;" },
  },
  {
    name: "a browser entrypoint of a typed package",
    manifest: { main: "dist/index.js", types: "dist/index.d.ts", browser: "dist/browser.js" },
    files: { "dist/index.d.ts": "export declare const value: number;" },
    entry: "dist/browser.js",
  },
  {
    name: "a browser replacement of a typed entrypoint",
    manifest: {
      main: "dist/index.js",
      browser: { "./dist/index.js": "./dist/browser.js" },
    },
    files: { "dist/index.d.ts": "export declare const value: number;" },
    entry: "dist/browser.js",
  },
  {
    name: "a wildcard export with sibling declarations",
    manifest: { exports: { "./features/*": "./dist/features/*.js" } },
    files: { "dist/features/foo.d.ts": "export declare const value: number;" },
    entry: "dist/features/foo.js",
  },
])("ignores JSDoc imports covered by $name", async ({ manifest, files, entry }) => {
  const diagnostics = await diagnose(manifest, {
    "dist/index.js": "export const value = 1;",
    [entry ?? "dist/index.js"]:
      '/** @param {import("phantom-types").Value} value */\nexport function use(value) { return value; }',
    ...files,
  });
  expect(diagnostics.map((d) => [d.code, d.message.match(/"([^"]+)"/)?.[1]])).toEqual([]);
});

test("reads JSDoc only from comments and skips runtime-provided specifiers", async () => {
  const diagnostics = await diagnose(
    { main: "index.js" },
    {
      "index.js": [
        'export const glob = (pattern) => pattern.endsWith("/**");',
        "export async function load() {",
        '  const [{ rm }] = await Promise.all([import("node:fs/promises")]);',
        '  return `const env = (await import("cloudflare:workers")).env`;',
        "}",
        '/** @param {import("node:fs").Stats} stats @param {import("phantom-types/sub").Value} value */',
        "export function inspect(stats, value) { return [stats, value]; }",
      ].join("\n"),
    },
  );
  expect(diagnostics.map((d) => [d.code, d.message.match(/"([^"]+)"/)?.[1]])).toEqual([
    ["PKG0002", "phantom-types/sub"],
  ]);
});

test.each([
  { main: 42 },
  { browser: { "./index.js": true } },
  { bin: { cli: false } },
  { dependencies: { h3: 42 } },
  { typesVersions: { "*": { "*": "index.d.ts" } } },
  { peerDependenciesMeta: { h3: { optional: "yes" } } },
])("rejects malformed package metadata %j", async (manifest) => {
  await expect(diagnose(manifest, {})).rejects.toThrow(
    `Invalid package.json field: ${Object.keys(manifest)[0]}`,
  );
});
