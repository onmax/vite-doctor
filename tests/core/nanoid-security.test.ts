import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { compileScript, compileStyle, parse } from "@vue/compiler-sfc";
import { expect, test } from "vite-plus/test";

const require = createRequire(import.meta.url);
const compilerRequire = createRequire(require.resolve("@vue/compiler-sfc/package.json"));
const postcssRequire = createRequire(compilerRequire.resolve("postcss/package.json"));
const nanoidRoot = dirname(postcssRequire.resolve("nanoid/package.json"));

test("the installed Nanoid native async generator returns an empty ID for zero sizes", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      "--input-type=module",
      "-e",
      `import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SourceTextModule, SyntheticModule } from "node:vm";
const root = process.argv[1];
const source = new SourceTextModule(readFileSync(join(root, "async/index.native.js"), "utf8"));
const alphabet = new SourceTextModule(readFileSync(join(root, "url-alphabet/index.js"), "utf8"));
const entropy = new SyntheticModule(["getRandomBytesAsync"], function () {
  this.setExport("getRandomBytesAsync", () => { throw new Error("Zero-size IDs must not request entropy"); });
});
await source.link(name => name === "expo-random" ? entropy : alphabet);
await source.evaluate();
const customAlphabet = source.namespace.customAlphabet;
console.log(JSON.stringify([await customAlphabet("ab", 0)(), await customAlphabet("ab", 6)(0)]));`,
      nanoidRoot,
    ],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
  );
  expect(JSON.parse(result)).toEqual(["", ""]);
});

test("PostCSS retains normal anonymous input IDs with the patched dependency", () => {
  const postcss = postcssRequire("postcss");
  const ast = postcss.parse(".button { color: red }");
  expect(ast.source.input.from).toMatch(/^<input css [\w-]{6}>$/);
  expect(ast.toString()).toBe(".button { color: red }");
  expect(require(join(nanoidRoot, "index.cjs")).customAlphabet("ab", 0)()).toBe("");
});

test("Vue script and scoped style compilation retain their PostCSS behavior", () => {
  const source = `<script setup lang="ts">const color: string = "red"</script>
<template><button class="button">Save</button></template>
<style scoped>.button { color: v-bind(color) }</style>`;
  const parsed = parse(source, { filename: "Button.vue" });
  expect(parsed.errors).toEqual([]);
  const script = compileScript(parsed.descriptor, { id: "test" });
  expect(script.content).toContain('const color: string = "red"');
  const style = compileStyle({
    source: parsed.descriptor.styles[0]!.content,
    filename: "Button.vue",
    id: "data-v-test",
    scoped: true,
  });
  expect(style.errors).toEqual([]);
  expect(style.code).toContain(".button[data-v-test]");
  expect(style.code).toContain("var(--test-color)");
});
