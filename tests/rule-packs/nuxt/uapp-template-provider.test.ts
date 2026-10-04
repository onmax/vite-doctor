import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { requireUAppRoot } from "../../../src/rule-packs/nuxt/rules/nuxt-ui.ts";

for (const file of ["app/app.vue", "app.vue", "app/layouts/default.vue", "layouts/default.vue"]) {
  test.each(["UApp", "u-app"])(`${file} recognizes %s provider`, async (tag) => {
    const result = await runRuleFixture({
      rule: requireUAppRoot,
      framework: "nuxt",
      files: {
        [file]: `<template><${tag}><NuxtPage /></${tag}></template>`,
        "app/pages/index.vue":
          "<script setup>const toast = useToast()</script><template><p>Home</p></template>",
      },
    });
    expect(result.diagnostics).toEqual([]);
  });
}

test.each([
  "<template><div v-pre><UApp /></div><NuxtPage /></template>",
  "<template><!-- <UApp><NuxtPage /></UApp> --><NuxtPage /></template>",
  '<script setup>const sample = "<UApp>"</script><template><NuxtPage /></template>',
  '<template><div data-example="<UApp>"><NuxtPage /></div></template>',
  "<template><u-app-extra><NuxtPage /></u-app-extra></template>",
  "<template><NuxtPage /></template>",
])("does not treat source text or unrelated tags as a root provider: %s", async (source) => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: {
      "app/app.vue": source,
      "app/pages/index.vue": "<script setup>const toast = useToast()</script>",
    },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([requireUAppRoot.meta.id]);
});

test.each(["UApp", "u-app"])("recognizes local %s providers", async (tag) => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup>const toast = useToast()</script><template><${tag}><p>Home</p></${tag}></template>`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  'const advice = "Wrap <UApp> before using useToast() or useOverlay()."',
  "// useToast() needs <UApp>\nexport const value = 1",
  "/* useOverlay() needs <UApp> */ export const value = 1",
  "const toast = /useToast\\(\\)/",
])("ignores service names in nonexecutable source: %s", async (source) => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: { "utils/advice.ts": source },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each(["useToast", "useOverlay"])(
  "reports actual %s service calls once per file",
  async (name) => {
    const result = await runRuleFixture({
      rule: requireUAppRoot,
      framework: "nuxt",
      files: { "app/pages/index.vue": `<script setup>${name}(); ${name}()</script>` },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([requireUAppRoot.meta.id]);
  },
);
