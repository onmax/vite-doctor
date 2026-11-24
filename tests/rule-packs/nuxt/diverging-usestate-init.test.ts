import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noDivergingUseStateInit } from "../../../src/rule-packs/nuxt/rules/nuxt/no-diverging-usestate-init.ts";

async function run(files: Record<string, string>) {
  const result = await runRuleFixture({ rule: noDivergingUseStateInit, framework: "nuxt", files });
  return result.diagnostics;
}

const page = (script: string) =>
  `<script setup lang="ts">\n${script}\n</script>\n<template><div /></template>`;

describe("nuxt/state/no-diverging-usestate-init", () => {
  test("reports one key initialized differently in a page and a composable", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page("const count = useState('count', () => 0)"),
      "app/composables/b.ts": "export const useB = () => useState('count', () => 10)\n",
    });

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic?.code).toBe("NUXT0097");
    expect(diagnostic?.severity).toBe("warn");
    expect(diagnostic?.file).toMatch(/app\/composables\/b\.ts$/);
    expect(diagnostic?.range?.line).toBe(1);
    expect(diagnostic?.why).toContain("'count'");
    expect(diagnostic?.why).toContain("() => 0");
    expect(diagnostic?.why).toContain("() => 10");
    expect(diagnostic?.suggestion).toContain("useState('count', () => 10)");
    expect(diagnostic?.related).toHaveLength(1);
    expect(diagnostic?.related?.[0]?.file).toMatch(/app\/pages\/a\.vue$/);
    expect(diagnostic?.related?.[0]?.range?.line).toBe(2);
    expect(diagnostic?.related?.[0]?.message).toContain("() => 0");
  });

  test("lists every other initializer of the key once", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page("const count = useState(`count`, () => 0)"),
      "app/pages/b.vue": page("const count = useState('count', () => 0)"),
      "app/components/C.vue": page('const count = useState("count", () => 5)'),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.related).toHaveLength(2);
  });

  test("stays quiet for one shared composable called from two places", async () => {
    const diagnostics = await run({
      "app/composables/useCount.ts": "export const useCount = () => useState('count', () => 0)\n",
      "app/pages/a.vue": page("const count = useCount()"),
      "app/pages/b.vue": page("const count = useCount()"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet for call sites that only read the key", async () => {
    const diagnostics = await run({
      "app/composables/useCount.ts": "export const useCount = () => useState('count', () => 0)\n",
      "app/pages/a.vue": page("const count = useState('count')"),
      "app/pages/b.vue": page("const count = useState<number>('count')"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet when initializers differ only in whitespace", async () => {
    const diagnostics = await run({
      "app/composables/a.ts": "export const useA = () => useState('user', () => ({ id: 0 }))\n",
      "app/pages/b.vue": page("const user = useState('user', ()=>({\n  id: 0\n}))"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet for different keys and dynamic keys", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page("const count = useState('count', () => 0)"),
      "app/pages/b.vue": page("const total = useState('total', () => 10)"),
      "app/pages/c.vue": page("const id = 'count'\nconst count = useState(`${id}`, () => 10)"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("ignores a useState that does not come from Nuxt", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page("const count = useState('count', () => 0)"),
      "app/composables/b.ts":
        "import { useState } from './local-state'\nexport const useB = () => useState('count', () => 10)\n",
      "app/composables/c.ts":
        "function useState(key: string, init: () => number) { return init() }\nexport const useC = () => useState('count', () => 20)\n",
    });

    expect(diagnostics).toEqual([]);
  });

  test("follows aliased Nuxt imports", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page("const count = useState('count', () => 0)"),
      "app/composables/b.ts":
        "import { useState as useNuxtState } from '#app'\nexport const useB = () => useNuxtState('count', () => 10)\n",
    });

    expect(diagnostics).toHaveLength(1);
  });
});
