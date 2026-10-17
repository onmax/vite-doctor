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
