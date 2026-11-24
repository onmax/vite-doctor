import { describe, expect, test } from "vite-plus/test";
import type { DoctorConfig } from "../../../src/core/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noDivergingUseStateInit } from "../../../src/rule-packs/nuxt/rules/nuxt/no-diverging-usestate-init.ts";

async function run(files: Record<string, string>, config?: DoctorConfig) {
  const result = await runProjectFixture({
    rules: [noDivergingUseStateInit],
    framework: "nuxt",
    files,
    config,
  });
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
    expect(diagnostic?.suggestion).toContain("one composable");
    expect(diagnostic?.suggestion).not.toContain("() => 10");
    expect(diagnostic?.why).not.toContain("clearNuxtState");
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

  test("ignores lexical shadowing of implicit and explicit imports", async () => {
    const diagnostics = await run({
      "app/pages/a.vue": page("useState('count', () => 0)"),
      "app/pages/b.vue": page(`
        import { useState as useNuxtState } from '#app'
        function useLocal(useNuxtState: typeof localState.useState) {
          const { useState } = localState
          useState('count', () => 1)
          useNuxtState('count', () => 2)
        }
        useNuxtState('count', () => 0)
      `),
    });
    expect(diagnostics).toEqual([]);
  });

  test("uses the resolved auto-import target for implicit and #imports calls", async () => {
    const diagnostics = await run({
      ".nuxt/doctor.manifest.json": JSON.stringify({
        autoImportEnabled: true,
        autoImports: [
          { name: "useState", from: "app/composables/local-state.ts" },
          { name: "useState", as: "nuxtState", from: "#app/composables/state" },
        ],
      }),
      "app/pages/a.vue": page("import { useState } from '#app'; useState('count', () => 0)"),
      "app/pages/b.vue": page("import { useState } from '#imports'; useState('count', () => 1)"),
      "app/pages/c.vue": page("useState('count', () => 2)"),
      "app/pages/d.vue": page("nuxtState('count', () => 3)"),
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.related?.map((site) => site.file)).toEqual([
      expect.stringMatching(/app\/pages\/d\.vue$/),
    ]);
  });

  test("keeps explicit #imports but ignores implicit calls when auto-import is disabled", async () => {
    const diagnostics = await run({
      ".nuxt/doctor.manifest.json": JSON.stringify({
        autoImportEnabled: false,
        autoImports: [{ name: "useState", from: "#app/composables/state" }],
      }),
      "app/pages/a.vue": page("import { useState } from '#app'; useState('count', () => 0)"),
      "app/pages/b.vue": page("useState('count', () => 1)"),
      "app/pages/c.vue": page("import { useState } from '#imports'; useState('count', () => 2)"),
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.related?.map((site) => site.file)).toEqual([
      expect.stringMatching(/app\/pages\/c\.vue$/),
    ]);
  });

  test.each<DoctorConfig>([{ exclude: ["**/z.vue"] }, { include: ["**/a.vue"] }])(
    "only uses the selected sources (%j)",
    async (config) => {
      expect(
        await run(
          {
            "app/pages/a.vue": page("useState('count', () => 0)"),
            "app/pages/z.vue": page("useState('count', () => 1)"),
          },
          config,
        ),
      ).toEqual([]);
    },
  );

  test("groups state per Nuxt app and includes each app's layers", async () => {
    const appPackage = JSON.stringify({ dependencies: { nuxt: "^4.0.0" } });
    const diagnostics = await run({
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "apps/admin/package.json": appPackage,
      "apps/shop/package.json": appPackage,
      "apps/admin/.nuxt/doctor.manifest.json": JSON.stringify({
        layers: [{ root: "." }, { root: "../../layers/base" }],
        autoImportEnabled: true,
        autoImports: [{ name: "useState", from: "#app/composables/state" }],
      }),
      "apps/admin/app/pages/a.vue": page("useState('shared', () => 0); useState('admin', () => 0)"),
      "apps/shop/app/pages/a.vue": page("useState('shared', () => 1); useState('shop', () => 0)"),
      "apps/shop/app/pages/b.vue": page("useState('shop', () => 1)"),
      "layers/base/app/composables/admin.ts": "useState('admin', () => 1)",
    });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.why)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("useState('admin')"),
        expect.stringContaining("useState('shop')"),
      ]),
    );
    expect(
      diagnostics.some(({ file }) => file.endsWith("layers/base/app/composables/admin.ts")),
    ).toBe(true);
  });

  test.each([
    ["() => 'dark mode'", "() => 'dark  mode'"],
    ["() => { return (1) }", "() => { return\n(1) }"],
  ])("preserves significant whitespace in %s and %s", async (left, right) => {
    const diagnostics = await run({
      "app/pages/a.vue": page(`useState('count', ${left})`),
      "app/pages/b.vue": page(`useState('count', ${right})`),
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.why).toContain(left);
    expect(diagnostics[0]?.why).toContain(right);
  });
});
