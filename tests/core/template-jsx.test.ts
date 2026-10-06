import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { runVueSfcRuleFixture } from "../rule-fixtures.ts";
import { parseSfcFile } from "../../src/core/internal/sfc.ts";
import { restrictVHtml } from "../../src/rule-packs/vue/rules/vue/restrict-v-html.ts";
import { parseSourceFiles } from "../../src/core/internal/facts.ts";
import { createCacheKey, createScanSession } from "../../src/core/internal/scan-session.ts";

const scripts = [
  '<script setup lang="jsx">const render = () => <span />;</script>',
  '<script lang="jsx">export default { render: () => <span /> };</script>',
  '<script setup lang="tsx">const render = (text: string) => <span>{text}</span>;</script>',
  '<script lang="tsx">export default { render: (text: string) => <span>{text}</span> };</script>',
];

test("rebuilds template references from persisted pre-JSX File Facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-template-jsx-cache-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(root, "App.vue"),
      `${scripts[0]}\n<template><div ref="element" /></template>`,
    );
    const options = { root, framework: "vue" as const, cache: true };
    const initial = await createScanSession(options);
    await parseSourceFiles(initial);
    const facts = initial.facts[0]!;
    expect(facts.templateRefs).toEqual([
      expect.objectContaining({ name: "ref", value: "element" }),
    ]);
    rmSync(join(root, ".vite-doctor/cache"), { recursive: true, force: true });
    const legacy = await createScanSession(options);
    const oldKey = createCacheKey(legacy, "fileFacts", `4:${facts.path}:${facts.fileHash}`);
    legacy.cache.set(oldKey, { ...facts, templateRefs: [] });
    legacy.cache.persist({ prune: false });

    const upgraded = await createScanSession(options);
    await parseSourceFiles(upgraded);

    expect(upgraded.facts[0]!.templateRefs).toEqual(facts.templateRefs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
