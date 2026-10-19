import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noBrowserApiInServer } from "../../../src/rule-packs/nitro/rules/no-browser-api-in-server.ts";
import { noBrowserGlobalInUniversalCode } from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { noBrowserApiInSetup } from "../../../src/rule-packs/vue/rules/vue/index.ts";

// Nuxt counts server/utils as Nitro server code; that is where the reported false positive lived.
async function nitroDiagnostics(source: string, file = "server/utils/markdown-document.ts") {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: noBrowserApiInServer,
    files: { [file]: source },
  });
  return result.diagnostics.map((item) => item.why);
}

const localBindings = {
  "a typed function parameter": `const parseMarkdown = async (source: string) => ({ frontmatter: { title: source }, nodes: [] })

export function documentTitle(document: Awaited<ReturnType<typeof parseMarkdown>>): string {
  if (typeof document.frontmatter.title === "string" && document.frontmatter.title.trim())
    return document.frontmatter.title.trim()
  return document.nodes.length ? "Heading" : "Untitled document"
}`,
  "an arrow function parameter": `export const title = (document: { title: string }) => document.title`,
  "a defaulted parameter": `export function title(document = { title: "" }) { return document.title }`,
  "a rest parameter": `export function titles(...document: { title: string }[]) { return document.map((item) => item.title) }`,
  "a destructured parameter": `export function title({ document }: { document: { title: string } }) { return document.title }`,
  "a renamed destructured parameter": `export function title({ value: document }: { value: { title: string } }) { return document.title }`,
  "an array-destructured parameter": `export function title([document]: [{ title: string }]) { return document.title }`,
  "a block-scoped variable": `export function title(input: string) {
  const document = { title: input }
  return document.title
}`,
  "a variable declared after its use in a closure": `export function read() { return document.title }
const document = { title: "Drop" }`,
  "a hoisted var in a nested block": `export function title(input: string) {
  if (input) { var document = { title: input } }
  return document?.title
}`,
  "a destructured variable": `export function title(input: { document: { title: string } }) {
  const { document } = input
  return document.title
}`,
  "a function declaration": `function document() { return { title: "Drop" } }
export const title = () => document().title`,
  "a named function expression": `export const title = function document(depth: number): string { return depth ? document(depth - 1) : "Drop" }`,
  "a class declaration": `class document { static title = "Drop" }
export const title = () => document.title`,
  "an import": `import { document } from "./documents"
export const title = () => document.title`,
  "a renamed import": `import { parsed as document } from "./documents"
export const title = () => document.title`,
  "a namespace import": `import * as document from "./documents"
export const title = () => document.title`,
  "a TypeScript import-equals binding": `import document = Documents.document
export const title = () => document.title`,
  "a TypeScript namespace binding": `namespace Documents {
  export const document = { title: "Drop" }
  export const title = document.title
}
export const title = () => Documents.title`,
  "a catch parameter": `export function title(read: () => string) {
  try { return read() }
  catch (document) { return String(document) }
}`,
  "a for-of variable": `export function titles(items: { title: string }[]) {
  const out: string[] = []
  for (const document of items) out.push(document.title)
  return out
}`,
  "a constructor parameter property": `export class Page {
  constructor(private document: { title: string }) {}
  title() { return this.document.title }
}`,
};

for (const [kind, source] of Object.entries(localBindings)) {
  test(`nitro/server/no-browser-api ignores document bound by ${kind}`, async () => {
    expect(await nitroDiagnostics(source)).toEqual([]);
  });
}

test("nitro/server/no-browser-api still reports the global document in a server route", async () => {
  expect(
    await nitroDiagnostics(
      `export default defineEventHandler(() => ({ title: document.title }))`,
      "server/api/title.get.ts",
    ),
  ).toEqual(["document is not available in Nitro server runtime."]);
});

test("nitro/server/no-browser-api still reports document imported only as a type", async () => {
  expect(
    await nitroDiagnostics(
      `import type { document } from "./documents"
export const title = () => document.title`,
    ),
  ).toEqual(["document is not available in Nitro server runtime."]);
});

test("nitro/server/no-browser-api reports the global when the binding lives in another scope", async () => {
  expect(
    await nitroDiagnostics(`function parse(input: string) {
  const document = { title: input }
  return document
}
export default defineEventHandler(() => document.title)`),
  ).toEqual(["document is not available in Nitro server runtime."]);
});

test("vue/ssr/no-browser-api-in-setup ignores a parameter named document", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInSetup,
    framework: "vue",
    dependencies: { "@vue/server-renderer": "^3.5.0" },
    files: {
      "app.vue": `<script setup lang="ts">
function documentTitle(document: { title: string }) { return document.title }
const title = documentTitle({ title: "Drop" })
</script>
<template>{{ title }}</template>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("vue/ssr/no-browser-api-in-setup still reports the global beside a parameter in another function", async () => {
  const result = await runRuleFixture({
    rule: noBrowserApiInSetup,
    framework: "vue",
    dependencies: { "@vue/server-renderer": "^3.5.0" },
    files: {
      "app.vue": `<script setup lang="ts">
function documentTitle(document: { title: string }) { return document.title }
const title = documentTitle(document)
</script>
<template>{{ title }}</template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "vue/ssr/no-browser-api-in-setup",
  ]);
});

test("nuxt/hydration/no-browser-global-in-universal-code ignores a parameter named document", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/utils/title.ts": `export function documentTitle(document: { title: string }) { return document.title }`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("nuxt/hydration/no-browser-global-in-universal-code still reports the global document", async () => {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
function documentTitle(document: { title: string }) { return document.title }
const title = documentTitle(document)
</script>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "nuxt/hydration/no-browser-global-in-universal-code",
  ]);
});
