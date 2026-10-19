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

test.each([
  [
    "a layer with a configured srcDir",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["./base"] })`,
      "base/nuxt.config.ts": `export default defineNuxtConfig({ srcDir: "src" })`,
      "base/src/app.vue": uappShell,
    },
  ],
  [
    "a CommonJS Nuxt config",
    {
      "nuxt.config.cjs": `module.exports = defineNuxtConfig({ extends: ["./base"] })`,
      "base/app/app.vue": uappShell,
    },
  ],
  [
    "a layer whose srcDir the manifest resolved",
    {
      ".nuxt/doctor.manifest.json": JSON.stringify({
        nuxtVersion: "4",
        vueVersion: "3.5",
        rootDir: ".",
        srcDir: "app",
        appDir: "app",
        buildDir: ".nuxt",
        autoImports: [],
        components: [],
        layers: [
          { root: ".", srcDir: "app", priority: 0 },
          { root: "theme", srcDir: "theme/source", priority: 1 },
        ],
        aliases: {},
        routeRules: {},
        serverHandlers: [],
        modules: [],
      }),
      "theme/source/app.vue": uappShell,
    },
  ],
  [
    "a manifest layer missing on disk",
    {
      ".nuxt/doctor.manifest.json": JSON.stringify({
        nuxtVersion: "4",
        vueVersion: "3.5",
        rootDir: ".",
        srcDir: "app",
        appDir: "app",
        buildDir: ".nuxt",
        autoImports: [],
        components: [],
        layers: [
          { root: ".", srcDir: "app", priority: 0 },
          { root: "node_modules/docus", srcDir: "node_modules/docus/app", priority: 1 },
        ],
        aliases: {},
        routeRules: {},
        serverHandlers: [],
        modules: [],
      }),
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

test.each([
  [
    "the project app.vue",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["./base"] })`,
      "app/app.vue": "<template><NuxtPage /></template>",
      "base/app/app.vue": uappShell,
    },
  ],
  [
    "a higher-priority layer",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["./first", "./second"] })`,
      "first/app/layouts/default.vue": "<template><slot /></template>",
      "second/app/layouts/default.vue": "<template><UApp><slot /></UApp></template>",
    },
  ],
])("reports when %s overrides a layer shell that renders UApp", async (_name, files) => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: { ...files, "app/pages/index.vue": toastPage },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([requireUAppRoot.meta.id]);
});

test.each([
  [
    "an extends value followed by a spread",
    {
      "nuxt.config.ts": `const shared = { extends: ["./base"] }; export default defineNuxtConfig({ extends: ["./missing"], ...shared })`,
      "base/app/app.vue": uappShell,
    },
  ],
  [
    "a srcDir followed by a spread",
    {
      "nuxt.config.ts": `const shared = { srcDir: "src" }; export default defineNuxtConfig({ srcDir: "./missing", ...shared })`,
      "src/app.vue": uappShell,
    },
  ],
  [
    "a srcDir built from a template expression",
    {
      "nuxt.config.ts": "export default defineNuxtConfig({ srcDir: `${process.cwd()}/src` })",
      "src/app.vue": uappShell,
    },
  ],
  [
    "a commented-out srcDir",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({\n  // srcDir: "src",\n})`,
      "app/app.vue": uappShell,
    },
  ],
  [
    "a local layer that extends lists ahead of other local layers",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["./layers/a"] })`,
      "layers/a/app/app.vue": uappShell,
      "layers/z/app/app.vue": "<template><NuxtPage /></template>",
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

test.each([
  [
    "a commented-out extends entry",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({\n  // extends: ["./missing"],\n})`,
    },
  ],
  [
    "an aliased extends entry",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["~~/base"] })`,
      "base/app/app.vue": "<template><NuxtPage /></template>",
    },
  ],
])("reports when %s provides no UApp", async (_name, files) => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: { ...files, "app/pages/index.vue": toastPage },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([requireUAppRoot.meta.id]);
});

test.each([
  [
    "a spread that can override extends",
    `const overrides = {}\nexport default defineNuxtConfig({ extends: ["./base"], ...overrides })`,
  ],
  ["an unknown config wrapper", `export default withConfig({ extends: ["./base"] })`],
])("does not report when %s hides the layers", async (_name, config) => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": config,
      "base/app/app.vue": "<template><NuxtPage /></template>",
      "app/pages/index.vue": toastPage,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("still reads options written after a spread", async () => {
  const result = await runRuleFixture({
    rule: requireUAppRoot,
    framework: "nuxt",
    files: {
      "nuxt.config.ts": `const shared = {}\nexport default defineNuxtConfig({ ...shared, srcDir: "app", extends: ["./base"] })`,
      "base/app/app.vue": "<template><NuxtPage /></template>",
      "app/pages/index.vue": toastPage,
    },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([requireUAppRoot.meta.id]);
});
