import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noBarrelFiles, viteRulePack } from "../../src/rules.ts";
import {
  diagnosticsCollectionSource,
  getDiagnosticDocuments,
  getRuleDocuments,
  rulesCollectionSource,
  strictOnlyRulePresets,
} from "../../docs/rules/source.ts";

const utils = {
  "src/utils/index.ts":
    "export * from './date'\nexport * from './currency'\nexport * from './charts'\n",
  "src/utils/date.ts":
    "export function formatDate(value: Date) {\n  return value.toISOString()\n}\nexport interface DateOptions { utc: boolean }\n",
  "src/utils/currency.ts": "export const toCurrency = (value: number) => `$${value}`\n",
  "src/utils/charts.ts": "export class Chart {}\n",
};

const tsconfig = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });

async function run(files: Record<string, string>) {
  return runProjectFixture({ framework: "vite", rules: [noBarrelFiles], files });
}

describe("vite/imports/no-barrel-files", () => {
  test("reports an aliased barrel import from a Vue SFC with the direct import", async () => {
    const result = await run({
      ...utils,
      "tsconfig.json": tsconfig,
      "src/pages/Home.vue": `<script setup lang="ts">
import { formatDate } from '@/utils'
const today = formatDate(new Date())
</script>
<template><p>{{ today }}</p></template>`,
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "VITE0023",
      ruleId: "vite/imports/no-barrel-files",
      severity: "info",
      range: { line: 2, column: 28 },
    });
    expect(result.diagnostics[0]?.file).toMatch(/src\/pages\/Home\.vue$/);
    expect(result.diagnostics[0]?.why).toContain("src/utils/index.ts");
    expect(result.diagnostics[0]?.why).toContain("re-exports 3 modules");
    expect(result.diagnostics[0]?.diagnostic.fix).toContain(
      "import { formatDate } from '@/utils/date'",
    );
  });

  test("falls back to the conventional @/ to src/ alias without tsconfig paths", async () => {
    const result = await run({
      ...utils,
      "src/main.ts": "import { toCurrency } from '@/utils'\nconsole.log(toCurrency(1))",
    });

    expect(result.diagnostics.map((item) => item.diagnostic.fix)).toEqual([
      expect.stringContaining("import { toCurrency } from '@/utils/currency'"),
    ]);
  });

  test("groups relative imports by defining module and keeps local aliases", async () => {
    const result = await run({
      ...utils,
      "src/utils/format.ts": "export const format = () => ''\n",
      "src/utils/index.ts": `${utils["src/utils/index.ts"]}export * from './format'\n`,
      "src/pages/home.ts":
        "import { formatDate as fmt, toCurrency, type DateOptions } from '../utils'\nconsole.log(fmt, toCurrency)",
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.why).toContain("only needs 2");
    expect(result.diagnostics[0]?.diagnostic.fix).toContain(
      "import { formatDate as fmt } from '../utils/date'\nimport { toCurrency } from '../utils/currency'",
    );
  });

  test("keeps explicit script extensions in the suggested specifier", async () => {
    const result = await run({
      ...utils,
      "src/main.ts": "import { Chart } from './utils/index.js'\nnew Chart()",
    });

    expect(result.diagnostics[0]?.diagnostic.fix).toContain(
      "import { Chart } from './utils/charts.js'",
    );
  });

  test("traces component barrels and nested barrels to the defining file", async () => {
    const result = await run({
      "src/components/index.ts": `export { default as Button } from './Button.vue'
export { default as Card } from './Card.vue'
import Dialog from './Dialog.vue'
export { Dialog }
export * from './forms'`,
      "src/components/Button.vue": "<template><button /></template>",
      "src/components/Card.vue": "<template><div /></template>",
      "src/components/Dialog.vue": "<template><dialog /></template>",
      "src/components/forms/index.ts":
        "export * from './input'\nexport * from './select'\nexport * from './checkbox'",
      "src/components/forms/input.ts": "export const useInput = () => {}",
      "src/components/forms/select.ts": "export const useSelect = () => {}",
      "src/components/forms/checkbox.ts": "export const useCheckbox = () => {}",
      "src/App.vue": `<script setup lang="ts">
import { Button, useSelect } from './components'
useSelect()
</script>
<template><Button /></template>`,
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.diagnostic.fix).toContain(
      "import Button from './components/Button.vue'\nimport { useSelect } from './components/forms/select'",
    );
  });

  test.each(["import './initialize'", "import { initialize } from './initialize'"])(
    "ignores a barrel with extra runtime initialization: %s",
    async (extra) => {
      const result = await run({
        ...utils,
        "src/utils/index.ts": `${extra}\n${utils["src/utils/index.ts"]}`,
        "src/utils/initialize.ts": "export const initialize = console.log('initialize')",
        "src/main.ts": "import { formatDate } from './utils'\nconsole.log(formatDate)",
      });
      expect(result.diagnostics).toEqual([]);
    },
  );

  test("does not trace through initialization in a nested re-export module", async () => {
    const result = await run({
      ...utils,
      "src/utils/date.ts": "import './initialize'\nexport { formatDate } from './format'",
      "src/utils/format.ts": utils["src/utils/date.ts"],
      "src/utils/initialize.ts": "console.log('initialize')",
      "src/main.ts": "import { formatDate } from './utils'\nconsole.log(formatDate)",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("allows type imports and re-exported default bindings", async () => {
    const result = await run({
      ...utils,
      "src/utils/index.ts": `import type { DateOptions } from './date'
import { type DateOptions as Options } from './date'
import { formatDate } from './date'
export default formatDate
export * from './currency'
export * from './charts'`,
      "src/main.ts": "import format from './utils'\nconsole.log(format)",
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.diagnostic.fix).toContain(
      "import { formatDate as format } from './utils/date'",
    );
  });

  test.each(["./utils?custom", "./utils/index.js?custom", "./utils#custom"])(
    "ignores module-ID postfixes: %s",
    async (specifier) => {
      const result = await run({
        ...utils,
        "src/main.ts": `import { formatDate } from '${specifier}'\nconsole.log(formatDate)`,
      });
      expect(result.diagnostics).toEqual([]);
    },
  );

  test.each(["./src/components/*/index.ts", "./dist/components/*/index.js"])(
    "ignores workspace package entries exposed by %s",
    async (target) => {
      const result = await run({
        "packages/ui/package.json": JSON.stringify({
          name: "@acme/ui",
          exports: { "./components/*": { import: target } },
        }),
        "packages/ui/src/components/utils/index.ts": utils["src/utils/index.ts"],
        "packages/ui/src/components/utils/date.ts": utils["src/utils/date.ts"],
        "packages/ui/src/components/utils/currency.ts": utils["src/utils/currency.ts"],
        "packages/ui/src/components/utils/charts.ts": utils["src/utils/charts.ts"],
        "src/main.ts":
          "import { formatDate } from '../packages/ui/src/components/utils'\nconsole.log(formatDate)",
      });
      expect(result.diagnostics).toEqual([]);
    },
  );

  test.each([
    ["./components/*", "./dist/*/*.js", 0],
    ["./components/*", "./dist/*/different/*.js", 1],
    ["./components/utils", "./dist/*/*.js", 1],
  ])("matches repeated export target stars consistently: %s -> %s", async (key, target, count) => {
    const result = await run({
      "packages/ui/package.json": JSON.stringify({ exports: { [key]: target } }),
      "packages/ui/src/utils/utils.ts": utils["src/utils/index.ts"],
      "packages/ui/src/utils/date.ts": utils["src/utils/date.ts"],
      "packages/ui/src/utils/currency.ts": utils["src/utils/currency.ts"],
      "packages/ui/src/utils/charts.ts": utils["src/utils/charts.ts"],
      "src/main.ts":
        "import { formatDate } from '../packages/ui/src/utils/utils'\nconsole.log(formatDate)",
    });
    expect(result.diagnostics).toHaveLength(count);
  });

  test("ignores barrels below the re-export threshold", async () => {
    const result = await run({
      "src/utils/index.ts": "export * from './date'\nexport * from './currency'",
      "src/utils/date.ts": utils["src/utils/date.ts"],
      "src/utils/currency.ts": utils["src/utils/currency.ts"],
      "src/main.ts": "import { formatDate } from './utils'\nformatDate(new Date())",
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("ignores imports that need every re-exported module", async () => {
    const result = await run({
      ...utils,
      "src/main.ts":
        "import { formatDate, toCurrency, Chart } from './utils'\nconsole.log(formatDate, toCurrency, Chart)",
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("ignores type-only, namespace, and side-effect imports", async () => {
    const result = await run({
      ...utils,
      "src/a.ts": "import type { DateOptions } from './utils'\nexport type A = DateOptions",
      "src/b.ts": "import { type DateOptions } from './utils'\nexport type B = DateOptions",
      "src/c.ts": "import { DateOptions } from './utils'\nexport type C = DateOptions",
      "src/d.ts": "import * as utils from './utils'\nconsole.log(utils)",
      "src/e.ts": "import './utils'",
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("ignores modules that declare their own code", async () => {
    const result = await run({
      ...utils,
      "src/utils/index.ts": `${utils["src/utils/index.ts"]}export const VERSION = '1'\n`,
      "src/main.ts": "import { formatDate } from './utils'\nformatDate(new Date())",
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("ignores barrels that are package entry points", async () => {
    const forExports = await run({
      ...utils,
      "package.json": JSON.stringify({
        name: "my-utils",
        type: "module",
        exports: { ".": { import: "./dist/utils/index.mjs" } },
        dependencies: { vite: "^8.0.0" },
      }),
      "src/main.ts": "import { formatDate } from './utils'\nformatDate(new Date())",
    });
    const workspacePackage = (manifest: Record<string, unknown>) =>
      run({
        "packages/ui/package.json": JSON.stringify(manifest),
        "packages/ui/src/index.ts": utils["src/utils/index.ts"],
        "packages/ui/src/date.ts": utils["src/utils/date.ts"],
        "packages/ui/src/currency.ts": utils["src/utils/currency.ts"],
        "packages/ui/src/charts.ts": utils["src/utils/charts.ts"],
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@acme/ui": ["./packages/ui/src/index.ts"] } },
        }),
        "src/main.ts": "import { formatDate } from '@acme/ui'\nformatDate(new Date())",
      });
    const forWorkspacePackage = await workspacePackage({
      name: "@acme/ui",
      main: "./src/index.ts",
    });
    const withoutEntry = await workspacePackage({ name: "@acme/ui" });

    expect(forExports.diagnostics).toEqual([]);
    expect(forWorkspacePackage.diagnostics).toEqual([]);
    expect(withoutEntry.diagnostics.map((item) => item.diagnostic.fix)).toEqual([
      expect.stringContaining("import { formatDate } from '../packages/ui/src/date'"),
    ]);
  });

  test("ignores node_modules, generated barrels, and unresolved re-exports", async () => {
    const result = await run({
      ...utils,
      "node_modules/lib/index.js": utils["src/utils/index.ts"],
      "src/a.ts": "import { formatDate } from 'lib'\nformatDate(new Date())",
      "src/generated/index.ts":
        "export * from '../utils/date'\nexport * from '../utils/currency'\nexport * from '../utils/charts'",
      "src/b.ts": "import { formatDate } from './generated'\nformatDate(new Date())",
      "src/api/index.ts": `// @generated by openapi-typescript\n${utils["src/utils/index.ts"]}`,
      "src/api/date.ts": utils["src/utils/date.ts"],
      "src/api/currency.ts": utils["src/utils/currency.ts"],
      "src/api/charts.ts": utils["src/utils/charts.ts"],
      "src/c.ts": "import { formatDate } from './api'\nformatDate(new Date())",
      "src/mixed/index.ts": `${utils["src/utils/index.ts"]}export * from 'date-fns'\n`.replaceAll(
        "./",
        "../utils/",
      ),
      "src/d.ts": "import { formatDate } from './mixed'\nformatDate(new Date())",
    });

    expect(result.diagnostics).toEqual([]);
  });

  test("is a Strict-only rule whose docs run it through the strict preset", async () => {
    expect(viteRulePack.presets?.recommended).not.toContain(noBarrelFiles.meta.id);
    expect(viteRulePack.presets?.strict).toContain(noBarrelFiles.meta.id);
    for (const [ruleId, preset] of strictOnlyRulePresets) {
      if (!ruleId.startsWith("vite/")) continue;
      expect(preset).toBe("vite/strict");
      expect(viteRulePack.presets?.recommended).not.toContain(ruleId);
      expect(viteRulePack.presets?.strict).toContain(ruleId);
    }
    const rulePage = await rulesCollectionSource.getItem(
      getRuleDocuments().find((rule) => rule.id === noBarrelFiles.meta.id)!.key,
    );
    expect(rulePage).toContain(
      "pnpm vite-doctor . --extends auto,vite/strict --rules vite/imports/no-barrel-files",
    );
    expect(getDiagnosticDocuments()).toContainEqual(
      expect.objectContaining({
        code: "VITE0023",
        ruleId: noBarrelFiles.meta.id,
        path: "/diagnostics/VITE0023",
      }),
    );
    const page = await diagnosticsCollectionSource.getItem("diagnostics/VITE0023.md");
    expect(page).toContain("import { formatDate } from '@/utils/date'");
    expect(page).toContain("fetches and transforms every module");
  });
});
