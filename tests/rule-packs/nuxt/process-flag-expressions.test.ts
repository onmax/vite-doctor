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
    name: "local dotted flag",
    source: "const process = { client: 'local' }; export const value = process.client",
    replacements: [],
  },
  {
    name: "imported process",
    source: "import process from 'node:process'; export const value = process.server",
    replacements: [],
  },
  {
    name: "function parameter",
    source: "export function flag(process) { return process.client }",
    replacements: [],
  },
  {
    name: "destructured parameter",
    source: "export function flag({ process }) { return process.server }",
    replacements: [],
  },
  {
    name: "hoisted var",
    source:
      "export function flag() { const flag = process.client; if (flag) { var process = { client: true } }; return flag }",
    replacements: [],
  },
  {
    name: "block binding and global reference",
    source:
      "{ const process = { client: 'local' }; console.log(process.client) }; export const value = process.server",
    replacements: ["import.meta.server"],
  },
  {
    name: "catch binding",
    source: "try {} catch (process) { console.log(process.server) }",
    replacements: [],
  },
  {
    name: "loop binding",
    source: "for (const process of []) { console.log(process.client) }",
    replacements: [],
  },
  {
    name: "named function expression",
    source: "export const flag = function process() { return process.server }",
    replacements: [],
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

test.each([
  {
    name: "TypeScript assertion",
    file: "app/plugins/flags.ts",
    source: "export const flag = <boolean>process.client",
    expression: "process.client",
  },
  {
    name: "TSX expression",
    file: "app/components/Flags.tsx",
    source: "export const flag = <div>{process.server}</div>",
    expression: "process.server",
  },
  {
    name: "JSX expression",
    file: "app/components/Flags.jsx",
    source: "export const flag = <div>{process.client}</div>",
    expression: "process.client",
  },
  {
    name: "Vue normal TypeScript assertion",
    file: "app/pages/index.vue",
    source: '<script lang="ts">export const flag = <boolean>process.server</script>',
    expression: "process.server",
  },
  {
    name: "Vue setup TypeScript assertion",
    file: "app/pages/index.vue",
    source: '<script setup lang="ts">const flag = <boolean>process.client</script>',
    expression: "process.client",
  },
  {
    name: "Vue TSX expression",
    file: "app/pages/index.vue",
    source: '<script setup lang="tsx">const flag = <div>{process.server}</div></script>',
    expression: "process.server",
  },
  {
    name: "Vue JSX expression",
    file: "app/pages/index.vue",
    source: '<script lang="jsx">export const flag = <div>{process.client}</div></script>',
    expression: "process.client",
  },
])("process flag parsing: $name", async ({ file, source, expression }) => {
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
    files: { [file]: source },
  });
  expect(result.diagnostics).toHaveLength(1);
  const edit = result.diagnostics[0]!.fix!.edits[0]!;
  expect(source.slice(edit.range.start, edit.range.end)).toBe(expression);
  expect(edit.text).toBe(expression.replace("process.", "import.meta."));
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

test("local process bindings suppress Vue script diagnostics", async () => {
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
    files: {
      "app/pages/index.vue": `<template><p>flags</p></template>
<script setup lang="ts">
const process = { client: 'local', server: 'local' }
const flags = [process.client, process.server]
</script>`,
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("mixed Vue script languages preserve JSX parsing", async () => {
  const source = `<template><p>flags</p></template>
<script lang="jsx">export const flag = <div>{process.client}</div></script>
<script setup lang="ts">const setupFlag = process.server</script>`;
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
  expect(result.diagnostics.map((diagnostic) => diagnostic.fix?.edits[0]?.text)).toEqual([
    "import.meta.client",
    "import.meta.server",
  ]);
});

test("mixed Vue script languages preserve TypeScript assertions", async () => {
  const source = `<template><p>flags</p></template>
<script lang="ts">export const flag = process.client as boolean</script>
<script setup lang="jsx">const view = <div>{process.server}</div></script>`;
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
  expect(result.diagnostics.map((diagnostic) => diagnostic.fix?.edits[0]?.text)).toEqual([
    "import.meta.client",
    "import.meta.server",
  ]);
});

test.each([
  {
    name: "setup binding leaves normal-script global unresolved",
    script: "export const flag = process.client",
    setup: "const process = { server: 'local' }; const flag = process.server",
    expected: ["process.client"],
  },
  {
    name: "normal-script binding is visible to setup",
    script:
      "const process = { client: 'local', server: 'local' }; export const flag = process.client",
    setup: "const flag = process.server",
    expected: [],
  },
  {
    name: "globals in both blocks preserve offsets",
    script: "export const flag = process.client",
    setup: "const flag = process.server",
    expected: ["process.client", "process.server"],
  },
])("mixed Vue scripts: $name", async ({ script, setup, expected }) => {
  const source = `<template><p>😀 flags</p></template>\r\n<script lang="ts">${script}</script>\r\n<script setup lang="ts">${setup}</script>`;
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
  const edits = result.diagnostics.map((diagnostic) => diagnostic.fix!.edits[0]!);
  expect(edits.map((edit) => source.slice(edit.range.start, edit.range.end))).toEqual(expected);
  let fixed = source;
  for (const edit of edits.toReversed())
    fixed = fixed.slice(0, edit.range.start) + edit.text + fixed.slice(edit.range.end);
  let expectedSource = source;
  for (const expression of expected)
    expectedSource = expectedSource.replace(
      expression,
      expression.replace("process.", "import.meta."),
    );
  expect(fixed).toBe(expectedSource);
});
