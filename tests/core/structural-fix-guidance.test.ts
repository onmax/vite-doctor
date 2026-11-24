import { expect, test } from "vite-plus/test";
import { STRUCTURAL_DIAGNOSTIC_CODES } from "../../src/core/diagnostic-constants.ts";
import type { Diagnostic } from "../../src/core/index.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noCircularSetupStateRead } from "../../src/rule-packs/pinia/rules/no-circular-setup-state-read.ts";
import { noDivergingUseStateInit } from "../../src/rule-packs/nuxt/rules/nuxt/no-diverging-usestate-init.ts";
import { noExternalSharedStateMutation } from "../../src/rule-packs/vue/rules/vue/index.ts";
import { noCircularImportAtHmrBoundary } from "../../src/rules.ts";

interface StructuralCase {
  run: () => Promise<Diagnostic[]>;
  fix: RegExp;
  avoid: RegExp;
}

const piniaStore = (name: string, other: string) => `import { defineStore } from 'pinia'
import { ref } from 'vue'
import { use${other}Store } from './${other.toLowerCase()}'

export const use${name}Store = defineStore('${name.toLowerCase()}', () => {
  const other = use${other}Store()
  other.name
  return { name: ref('${name}') }
})
`;

const page = (script: string) =>
  `<script setup lang="ts">\n${script}\n</script>\n<template><div /></template>`;

const sharedWriter = `import { store } from './store'; store.count++`;

const cases: Record<string, StructuralCase> = {
  DOC0001: {
    run: async () =>
      (
        await runProjectFixture({
          framework: "vite",
          rules: [],
          run: { analyses: "graph" },
          files: {
            "src/a.ts": 'import { b } from "./b";\nexport const a = () => b;\n',
            "src/b.ts": 'import { a } from "./a";\nexport const b = () => a;\n',
          },
        })
      ).diagnostics,
    fix: /cut the one that points from a lower layer to a higher one/,
    avoid: /Do not hide the cycle behind a dynamic import\(\)/,
  },
  PINIA0003: {
    run: async () =>
      (
        await runProjectFixture({
          dependencies: { pinia: "^3.0.0" },
          rules: [noCircularSetupStateRead],
          files: {
            "src/stores/x.ts": piniaStore("X", "Y"),
            "src/stores/y.ts": piniaStore("Y", "X"),
          },
        })
      ).diagnostics,
    fix: /Defer every reported read to a computed\(\) getter or an action/,
    avoid: /Do not move a read into another store on the cycle or suppress this Diagnostic/,
  },
  NUXT0097: {
    run: async () =>
      (
        await runProjectFixture({
          framework: "nuxt",
          rules: [noDivergingUseStateInit],
          files: {
            "app/pages/a.vue": page("const count = useState('count', () => 0)"),
            "app/composables/b.ts": "export const useB = () => useState('count', () => 10)\n",
          },
        })
      ).diagnostics,
    fix: /Initialize 'count' in one composable and call it from every site/,
    avoid: /Do not copy one initializer into every site or suppress this Diagnostic/,
  },
  VUE0048: {
    run: async () =>
      (
        await runProjectFixture({
          rules: [noExternalSharedStateMutation],
          files: {
            "src/store.ts":
              "import { reactive } from 'vue'\nexport const store = reactive({ count: 0 })\nexport function increment() { store.count++ }\n",
            "src/a.ts": sharedWriter,
            "src/b.ts": sharedWriter,
          },
        })
      ).diagnostics,
    fix: /Replace each direct write with a call to increment\(\)/,
    avoid: /do not copy it into each component or move ownership into one component/,
  },
  VITE0029: {
    run: async () =>
      (
        await runProjectFixture({
          framework: "vue",
          rules: [noCircularImportAtHmrBoundary],
          files: {
            "src/main.ts": 'import { router } from "./router";\nrouter.start();\n',
            "src/router.ts":
              'import Page from "./Page.vue";\nexport const router = { routes: [{ path: "/", component: Page }], push(path: string) {}, start() {} };\n',
            "src/Page.vue": page('import { router } from "./router";\nrouter.push("/");'),
          },
        })
      ).diagnostics,
    fix: /Remove the import that leads from src\/Page\.vue back into the cycle/,
    avoid: /Do not decline HMR with import\.meta\.hot\.decline\(\) or suppress this Diagnostic/,
  },
};

test.each([...STRUCTURAL_DIAGNOSTIC_CODES])(
  "%s fix names the one fix and the move that only hides the cause",
  async (code) => {
    const structural = cases[code];
    if (!structural)
      throw new Error(`${code} is in STRUCTURAL_DIAGNOSTIC_CODES but has no fixture in this test.`);
    const diagnostics = (await structural.run()).filter((item) => item.code === code);
    expect(diagnostics, `${code} fixture must report the Diagnostic`).not.toHaveLength(0);
    for (const { suggestion } of diagnostics) {
      expect(suggestion).toMatch(structural.fix);
      expect(suggestion).toMatch(structural.avoid);
    }
  },
);

test("every structural fixture belongs to a listed code", () => {
  expect(Object.keys(cases).sort()).toEqual([...STRUCTURAL_DIAGNOSTIC_CODES].sort());
});
