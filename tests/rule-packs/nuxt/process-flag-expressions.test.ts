import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noLegacyProcessClientServer } from "../../../src/rule-packs/nuxt/rules/nuxt/no-legacy-process-client-server.ts";

const cases = [
  {
    name: "literal process receiver",
    source: "export const value = 'process'.client",
    replacements: [],
  },
  {
    name: "call receiver chain",
    source:
      "function getObject() { return { process: { client: 'nested' } } }; export const value = getObject().process.client",
    replacements: [],
  },
  {
    name: "computed call receiver chain",
    source:
      "function getObject() { return { process: { client: 'nested' } } }; export const value = getObject()['process'].client",
    replacements: [],
  },
  {
    name: "object expression receiver chain",
    source: "export const value = ({ process: { server: 'nested' } }).process.server",
    replacements: [],
  },
  {
    name: "client flag",
    source: "export const value = process.client",
    replacements: ["import.meta.client"],
  },
  {
    name: "server flag",
    source: "export const value = process.server",
    replacements: ["import.meta.server"],
  },
  {
    name: "both flags",
    source: "export const value = process.client || process.server",
    replacements: ["import.meta.client", "import.meta.server"],
  },
  {
    name: "parenthesized access outside the host macro form",
    source: "export const value = (process).client",
    replacements: [],
  },
  {
    name: "host-substituted local dotted flag",
    source: "const process = { client: 'local' }; export const value = process.client",
    replacements: ["import.meta.client"],
  },
  { name: "string value", source: "export const value = 'process.client'", replacements: [] },
  {
    name: "string method receiver",
    source: "export const value = 'process.server'.toUpperCase()",
    replacements: [],
  },
  {
    name: "object key",
    source: "export const value = { 'process.client': 'data' }",
    replacements: [],
  },
  {
    name: "dynamic client property",
    source:
      "const process = { server: 'local' }; const client = 'server'; export const value = process[client]",
    replacements: [],
  },
  {
    name: "dynamic server property",
    source:
      "const process = { client: 'local' }; const server = 'client'; export const value = process[server]",
    replacements: [],
  },
  {
    name: "local bracket client property",
    source: "const process = { client: 'local' }; export const value = process['client']",
    replacements: [],
  },
  {
    name: "local bracket server property",
    source: "const process = { server: 'local' }; export const value = process['server']",
    replacements: [],
  },
  {
    name: "global bracket property",
    source: "export const value = process['client']",
    replacements: [],
  },
  {
    name: "optional client property",
    source: "export const value = process?.client",
    replacements: [],
  },
  {
    name: "unrelated object",
    source:
      "const object = { process: { client: 'local' } }; export const value = object.process.client",
    replacements: [],
  },
  { name: "comment", source: "// process.client\nexport const value = 1", replacements: [] },
];

test.each(cases)("process flag expressions: $name", async ({ source, replacements }) => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [noLegacyProcessClientServer],
    run: {
      runtimeTarget: {
        nuxt: "4.5.1",
        nitro: "2.13.4",
        h3: "1.15.11",
        vue: "3.5.0",
        nuxtCompatibility: 5,
      },
    },
    files: { "app/plugins/flags.ts": source },
  });
  expect(result.diagnostics.map((item) => item.fix?.edits[0]?.text)).toEqual(replacements);
  for (const diagnostic of result.diagnostics) expect(diagnostic.fix?.kind).toBe("safe");
});

test("process flag edits preserve Vue script offsets and neighboring literals", async () => {
  const source = `<template><p>process.client</p></template>\n<script setup lang="ts">\nconst label = 'process.client'\nconst flag = process.client\n</script>`;
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [noLegacyProcessClientServer],
    run: {
      runtimeTarget: {
        nuxt: "4.5.1",
        nitro: "2.13.4",
        h3: "1.15.11",
        vue: "3.5.0",
        nuxtCompatibility: 5,
      },
    },
    files: { "app/pages/index.vue": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  const edit = result.diagnostics[0]!.fix!.edits[0]!;
  expect(source.slice(edit.range.start, edit.range.end)).toBe("process.client");
  expect(source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end)).toContain(
    "const label = 'process.client'\nconst flag = import.meta.client",
  );
});
