import { expect, test } from "vite-plus/test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { runVueSfcRuleFixture } from "../../src/core/testkit.ts";
import { parseSfcFile } from "../../src/core/internal/sfc.ts";
import { restrictVHtml } from "../../src/rule-packs/vue/rules/vue/restrict-v-html.ts";

const scripts = [
  '<script setup lang="jsx">const render = () => <span />;</script>',
  '<script lang="jsx">export default { render: () => <span /> };</script>',
  '<script setup lang="tsx">const render = (text: string) => <span>{text}</span>;</script>',
  '<script lang="tsx">export default { render: (text: string) => <span>{text}</span> };</script>',
];

test.each(scripts)("keeps template diagnostics for %s", async (script) => {
  for (const newline of ["\n", "\r\n"]) {
    const element = '<div v-html="html" />';
    const source = [script, "<template>", `  ${element}`, "</template>"].join(newline);
    const parsed = parse(source, { filename: "app.vue" });
    expect(parsed.errors).toEqual([]);
    expect(() => compileScript(parsed.descriptor, { id: "template-jsx-fixture" })).not.toThrow();
    const sfc = await parseSfcFile("app.vue", source);
    expect(await sfc.getTemplateTokens()).toMatchObject({ type: "VElement", rawName: "template" });
    const result = await runVueSfcRuleFixture(restrictVHtml, source);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        ruleId: restrictVHtml.meta.id,
        range: {
          start: source.indexOf(element),
          end: source.indexOf(element) + element.length,
          line: 3,
          column: 3,
        },
      }),
    ]);

    const valid = source.replace(element, "<div>{{ html }}</div>");
    expect((await runVueSfcRuleFixture(restrictVHtml, valid)).diagnostics).toEqual([]);
  }
});

test.each([
  '<script setup>const html = "hello";</script>',
  '<script setup lang="ts">const html: string = "hello";</script>',
  '<script setup lang="ts">const html = <string>"hello";</script>',
])("preserves existing template diagnostics for %s", async (script) => {
  const source = `${script}\n<template><div v-html="html" /></template>`;
  const result = await runVueSfcRuleFixture(restrictVHtml, source);
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    restrictVHtml.meta.id,
  ]);
});
