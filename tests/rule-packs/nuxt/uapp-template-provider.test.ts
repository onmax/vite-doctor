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
  "reports %s calls beside a non-Vue template example",
  async (name) => {
    const result = await runRuleFixture({
      rule: requireUAppRoot,
      framework: "nuxt",
      files: {
        "composables/service.ts": `const example = "<template><UApp /></template>"; ${name}()`,
      },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([requireUAppRoot.meta.id]);
  },
);

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

const toastPage = "<script setup>const toast = useToast()</script><template><p>Home</p></template>";
const uappShell = "<template><UApp><NuxtPage /></UApp></template>";

test.each([
  [
    "a relative layer",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["./base"] })`,
      "base/app/app.vue": uappShell,
    },
  ],
  [
    "a package layer",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: "docs-theme" })`,
      "node_modules/docs-theme/package.json": `{ "name": "docs-theme" }`,
      "node_modules/docs-theme/app/app.vue": uappShell,
    },
  ],
  [
    "a nested layer",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["./base"] })`,
      "base/nuxt.config.ts": `export default defineNuxtConfig({ extends: ["../theme"] })`,
      "theme/layouts/default.vue": uappShell,
    },
  ],
  ["an auto-registered layer", { "layers/theme/app/app.vue": uappShell }],
  [
    "a layer that cannot be resolved",
    { "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["docus"] })` },
  ],
  [
    "a remote layer",
    { "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["github:org/theme"] })` },
  ],
  [
    "a computed extends value",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: process.env.THEME ? [process.env.THEME] : [] })`,
    },
  ],
])("accepts a UApp provider from %s", async (_name, files) => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: { ...files, "app/pages/index.vue": toastPage },
  });
  expect(result.diagnostics).toEqual([]);
});

test("reports when every extended layer is resolved and none provides UApp", async () => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["./base", "docs-theme"] })`,
      "base/app/app.vue": "<template><NuxtPage /></template>",
      "node_modules/docs-theme/package.json": `{ "name": "docs-theme" }`,
      "node_modules/docs-theme/app/app.vue": "<template><NuxtPage /></template>",
      "app/pages/index.vue": toastPage,
    },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([requireUAppRoot.meta.id]);
});
