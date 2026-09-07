import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { requireStaticGlobPattern, viteRulePack } from "../../src/rules.ts";
import { diagnosticsCollectionSource, getDiagnosticDocuments } from "../../docs/rules/source.ts";

describe("Vite glob imports", () => {
  test.each([
    "pattern",
    "`./pages/${name}.ts`",
    "'./pages/' + name + '.ts'",
    "['./pages/*.ts', pattern]",
    "[...patterns]",
    "...patterns",
    "42",
    "null",
    "",
    "pattern as string",
  ])("reports a pattern that Vite cannot transform: %s", async (pattern) => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [requireStaticGlobPattern],
      files: {
        "src/main.ts": `const pattern = './pages/*.ts'
const patterns = ['./pages/*.ts']
const name = 'home'
const pages = import.meta.glob(${pattern})`,
      },
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "VITE0022",
      ruleId: "vite/imports/require-static-glob-pattern",
      severity: "error",
      range: { line: 4 },
    });
    expect(result.diagnostics[0]?.file).toMatch(/src\/main\.ts$/);
  });

  test("accepts Vite's literal patterns and TypeScript assertions", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [requireStaticGlobPattern],
      files: {
        "src/main.ts": `const a = import.meta.glob('./pages/*.ts')
const b = import.meta.glob(['./pages/*.ts', '!./pages/private/*.ts'])
const c = import.meta.glob(\`./pages/*.ts\`, { eager: true })
const d = import.meta.glob('./pages/*.ts' as const)
const e = import.meta.glob(['./pages/*.ts'] satisfies string[])
const f = import.meta.glob([, './pages/*.ts'])
const g = import.meta.glob([])
const h = import.meta.glob(['./pages/*.ts' as const])
const i = import.meta.glob<string>('./pages/*.ts')
const j = import.meta.glob((('./pages/*.ts' as string)!))`,
      },
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("does not mistake other glob APIs, strings, or comments for Vite glob calls", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [requireStaticGlobPattern],
      files: {
        "src/main.ts": `const files = glob(pattern)
const other = tools.glob(pattern)
const computed = import.meta[glob](pattern)
const text = 'import.meta.glob(pattern)'
// import.meta.glob(pattern)`,
      },
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("reports Vue script patterns with their source location", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [requireStaticGlobPattern],
      files: {
        "src/App.vue": `<script setup lang="ts">
const pattern = './pages/*.vue'
const pages = import.meta.glob(pattern)
</script>
<template><div /></template>`,
      },
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "VITE0022",
      range: { line: 3, column: 32 },
    });
  });

  test("enables the rule by default and generates its Diagnostic Reference", async () => {
    expect(viteRulePack.presets?.recommended).toContain(requireStaticGlobPattern.meta.id);
    expect(getDiagnosticDocuments()).toContainEqual(
      expect.objectContaining({
        code: "VITE0022",
        ruleId: requireStaticGlobPattern.meta.id,
        path: "/diagnostics/VITE0022",
      }),
    );
    const page = await diagnosticsCollectionSource.getItem("diagnostics/VITE0022.md");
    expect(page).toContain("import.meta.glob");
    expect(page).toContain("module map");
  });
});
