import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { diagnostics } from "../../src/diagnostics.ts";
import { pluginPackageNamingConventions, viteRulePack } from "../../src/rules.ts";
import { diagnosticsCollectionSource, getDiagnosticDocuments } from "../../docs/rules/source.ts";

const typedFactory = `import type { Plugin } from 'vite'

export default function icons(): Plugin {
  return {
    name: 'icons',
    resolveId(id) {
      return id
    },
  }
}
`;

const untypedFactory = `export function icons(options = {}) {
  return {
    name: 'icons',
    transform: {
      filter: { id: /\\.svg$/ },
      handler(code) {
        return code
      },
    },
  }
}
`;

function manifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify(
    {
      name: "my-icons",
      version: "1.0.0",
      type: "module",
      keywords: ["icons"],
      exports: { ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" } },
      peerDependencies: { vite: "^8.0.0" },
      ...overrides,
    },
    null,
    2,
  );
}

async function run(packageJson: string, files: Record<string, string> = {}) {
  return runProjectFixture({
    framework: "vite",
    rules: [pluginPackageNamingConventions],
    files: { "package.json": packageJson, "src/index.ts": typedFactory, ...files },
  });
}

function findings(result: Awaited<ReturnType<typeof run>>) {
  return result.diagnostics.map((item) => ({
    code: item.code,
    line: item.range?.line,
    why: item.why,
    fix: item.diagnostic.fix,
  }));
}

describe("vite/plugin-package/naming-conventions", () => {
  test("reports the package name and keywords of a published Vite plugin", async () => {
    const result = await run(manifest());

    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((item) => item.file.endsWith("/package.json"))).toBe(true);
    expect(result.diagnostics.map((item) => item.severity)).toEqual(["warn", "warn"]);
    expect(findings(result)).toEqual([
      {
        code: "VITE0024",
        line: 2,
        why: expect.stringContaining("does not start with vite-plugin-"),
        fix: expect.stringContaining('"vite-plugin-my-icons"'),
      },
      {
        code: "VITE0024",
        line: 5,
        why: expect.stringContaining('do not include "vite-plugin"'),
        fix: expect.stringContaining('Add "vite-plugin"'),
      },
    ]);
  });

  test("accepts the documented valid package", async () => {
    const result = await run(
      manifest({ name: "vite-plugin-icons", keywords: ["vite-plugin", "icons"] }),
    );

    expect(result.diagnostics).toEqual([]);
  });

  test("reports only the missing keyword for a prefixed package", async () => {
    const result = await run(manifest({ name: "vite-plugin-icons", keywords: undefined }));

    expect(findings(result)).toEqual([
      expect.objectContaining({ line: 2, why: expect.stringContaining('"vite-plugin"') }),
    ]);
  });

  test("asks plugins that require one framework to include it in the prefix", async () => {
    const vue = await run(
      manifest({
        name: "vite-plugin-icons",
        keywords: ["vite-plugin"],
        peerDependencies: { vite: "^8.0.0", vue: "^3.5.0" },
      }),
    );
    const react = await run(
      manifest({
        name: "icons-vite",
        keywords: ["vite-plugin"],
        peerDependencies: { vite: "^8.0.0", "react-dom": "^19.0.0" },
      }),
    );
    const prefixed = await run(
      manifest({
        name: "vite-plugin-vue-icons",
        keywords: ["vite-plugin"],
        peerDependencies: { vite: "^8.0.0", vue: "^3.5.0" },
      }),
    );
    const optional = await run(
      manifest({
        name: "vite-plugin-icons",
        keywords: ["vite-plugin"],
        peerDependencies: { vite: "^8.0.0", vue: "^3.5.0" },
        peerDependenciesMeta: { vue: { optional: true } },
      }),
    );
    const multiple = await run(
      manifest({
        name: "vite-plugin-icons",
        keywords: ["vite-plugin"],
        peerDependencies: { vite: "^8.0.0", vue: "^3.5.0", svelte: "^5.0.0" },
      }),
    );

    expect(findings(vue)).toEqual([
      expect.objectContaining({ fix: expect.stringContaining('"vite-plugin-vue-icons"') }),
    ]);
    expect(findings(react)).toEqual([
      expect.objectContaining({ fix: expect.stringContaining('"vite-plugin-react-icons"') }),
    ]);
    expect(prefixed.diagnostics).toEqual([]);
    expect(optional.diagnostics).toEqual([]);
    expect(multiple.diagnostics).toEqual([]);
  });

  test("applies the Rolldown and Rollup compatible plugin keywords", async () => {
    const rolldown = await run(
      manifest({ name: "rolldown-plugin-icons", keywords: ["vite-plugin"] }),
    );
    const rollup = await run(manifest({ name: "rollup-plugin-icons", keywords: [] }));
    const compliant = await run(
      manifest({ name: "rolldown-plugin-icons", keywords: ["rolldown-plugin", "vite-plugin"] }),
    );

    expect(findings(rolldown)).toEqual([
      expect.objectContaining({
        why: expect.stringContaining('do not include "rolldown-plugin"'),
      }),
    ]);
    expect(findings(rollup)).toEqual([
      expect.objectContaining({
        why: expect.stringContaining('do not include "rollup-plugin" and "vite-plugin"'),
      }),
    ]);
    expect(compliant.diagnostics).toEqual([]);
  });

  test("checks only keywords for scoped packages", async () => {
    const missing = await run(manifest({ name: "@acme/icons", keywords: ["icons"] }));
    const present = await run(manifest({ name: "@acme/icons", keywords: ["vite-plugin"] }));

    expect(findings(missing)).toEqual([
      expect.objectContaining({ why: expect.stringContaining('"vite-plugin"') }),
    ]);
    expect(present.diagnostics).toEqual([]);
  });

  test("follows re-exports and main fields to the plugin factory", async () => {
    const reexported = await run(manifest({ exports: undefined, main: "./dist/index.cjs" }), {
      "src/index.ts":
        "export { icons as default } from './plugin.js'\nexport type { Options } from './types'",
      "src/plugin.ts": untypedFactory,
    });
    const imported = await run(manifest(), {
      "src/index.ts": "import { icons } from './plugin'\nexport { icons }",
      "src/plugin.ts": untypedFactory,
    });
    const satisfies = await run(manifest(), {
      "src/index.ts": `import type { PluginOption as Option } from 'vite'
export const icons = () => [{ name: 'icons' }] satisfies Option[]`,
    });

    expect(reexported.diagnostics).toHaveLength(2);
    expect(imported.diagnostics).toHaveLength(2);
    expect(satisfies.diagnostics).toHaveLength(2);
  });

  test.each([
    "module.exports = icons",
    "exports.default = icons",
    "exports.icons = icons",
    "module.exports.icons = icons",
    "module.exports = () => ({ name: 'icons', transform(code) { return code } })",
  ])("recognizes CommonJS factories: %s", async (assignment) => {
    const result = await run(manifest({ exports: undefined, main: "./dist/index.cjs" }), {
      "src/index.ts": "",
      "dist/index.cjs": `${untypedFactory.replace("export ", "")}\n${assignment}`,
    });
    expect(result.diagnostics).toHaveLength(2);
  });

  test("ignores CommonJS exports of utilities and unrelated assignments", async () => {
    const result = await run(manifest({ exports: undefined, main: "./dist/index.cjs" }), {
      "src/index.ts": "",
      "dist/index.cjs": `${untypedFactory.replace("export ", "")}
const registry = {}; registry.icons = icons;
module.exports = () => ({ name: 'config', options: {} });`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    "const metadata = { name: 'metadata', transform: { handler() {} } }; return { name: 'config', options: {} }",
    "function nested() { return { name: 'nested', transform() {} } }; return {}",
    "return { metadata: { name: 'metadata', transform() {} } }",
    "const metadata: Plugin = { name: 'metadata' }; return {}",
    "const metadata: Option = { name: 'metadata' }; return {}",
    "const plugin: Plugin = { name: 'icons' }; { const plugin = {}; return plugin }",
    "return { name: 'config', transform: { handler: true } }",
  ])("ignores unrelated plugin evidence: %s", async (body) => {
    const result = await run(manifest(), {
      "src/index.ts": `import type { Plugin, PluginOption as Option } from 'vite'; export default function config() { ${body} }`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    "return [{ name: 'icons', transform() {} }]",
    "const plugin = { name: 'icons', transform() {} }; return plugin",
    "const plugin: Plugin = { name: 'icons' }; return plugin",
    "const plugin: Option = { name: 'icons' }; return plugin",
    "const plugin: Plugin = { name: 'icons' }; const alias = plugin; return [alias]",
    "return ({ name: 'icons' } as Plugin)",
    "if (enabled) return { name: 'icons', transform() {} }; return false",
    "return enabled ? { name: 'icons', transform() {} } : false",
  ])("recognizes returned plugin values: %s", async (body) => {
    const result = await run(manifest(), {
      "src/index.ts": `import type { Plugin, PluginOption as Option } from 'vite'; export default function icons(enabled = true) { ${body} }`,
    });
    expect(result.diagnostics).toHaveLength(2);
  });

  test("ignores apps, private packages, CLIs, and packages without a vite peer", async () => {
    const app = await run(JSON.stringify({ private: true, devDependencies: { vite: "^8.0.0" } }));
    const privatePackage = await run(manifest({ private: true }));
    const cli = await run(manifest({ bin: { "my-icons": "./dist/cli.mjs" } }));
    const devOnly = await run(
      manifest({ peerDependencies: undefined, devDependencies: { vite: "^8.0.0" } }),
    );
    const optionalVite = await run(
      manifest({ peerDependenciesMeta: { vite: { optional: true } } }),
    );

    expect(app.diagnostics).toEqual([]);
    expect(privatePackage.diagnostics).toEqual([]);
    expect(cli.diagnostics).toEqual([]);
    expect(devOnly.diagnostics).toEqual([]);
    expect(optionalVite.diagnostics).toEqual([]);
  });

  test("ignores packages whose main entry does not export a Vite plugin", async () => {
    const subpathOnly = await run(
      manifest({ exports: { "./vite": "./dist/vite.mjs", "./webpack": "./dist/webpack.mjs" } }),
      { "src/vite.ts": typedFactory },
    );
    const utility = await run(manifest(), {
      "src/index.ts": `export function createIcons() {
  return { name: 'icons', options: { size: 24 }, load: true }
}
export const plugin = { name: 'icons', transform: (code: string) => code }`,
    });
    const otherExport = await run(manifest(), {
      "src/index.ts": "export { helper } from './plugin'",
      "src/plugin.ts": `${untypedFactory}export const helper = () => 1\n`,
    });
    const typeOnly = await run(manifest(), {
      "src/index.ts": "export type { Plugin } from 'vite'\nexport const version = '1'",
    });

    expect(subpathOnly.diagnostics).toEqual([]);
    expect(utility.diagnostics).toEqual([]);
    expect(otherExport.diagnostics).toEqual([]);
    expect(typeOnly.diagnostics).toEqual([]);
  });

  test("is Recommended, uses VITE0024 only, and documents the convention", async () => {
    expect(viteRulePack.presets?.recommended).toContain(pluginPackageNamingConventions.meta.id);
    expect(Object.keys(diagnostics)).not.toContain("VITE0025");
    expect(getDiagnosticDocuments()).toContainEqual(
      expect.objectContaining({
        code: "VITE0024",
        ruleId: pluginPackageNamingConventions.meta.id,
        path: "/diagnostics/VITE0024",
      }),
    );
    const page = await diagnosticsCollectionSource.getItem("diagnostics/VITE0024.md");
    expect(page).toContain('"name": "vite-plugin-icons"');
    expect(page).toContain("vite-plugin-vue-");
  });
});
