import { describe, expect, test } from "vite-plus/test";
import {
  viteRulePack,
  noBroadEnvPrefix,
  noBroadFsAllow,
  noClientSecretPattern,
  noDisabledFsStrict,
  noDynamicNewUrl,
  noDynamicWorkerUrl,
  noBrowserGlobalInSsrEntry,
  noEmptyEnvPrefix,
  noNodeApiInWorker,
  noPublicSrcImport,
  noRuntimeObjectDefine,
  noSecretDefine,
  noSrcAbsolutePublicUrl,
  noUntypedDefine,
  noUntypedEnv,
  noUnusedDefine,
  preferDirectImportMetaEnvAccess,
  preferTransformFilter,
  requireDisposeForSideEffects,
  requirePluginName,
  requireWorkerUrlPattern,
} from "../../src/rules.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";

describe("vite rule pack", () => {
  test("exports recommended Vite rules", () => {
    expect(viteRulePack.name).toBe("vite-doctor/vite");
    expect(viteRulePack.presets?.recommended).toContain("vite/define/no-secret-define");
    expect(viteRulePack.presets?.recommended).not.toContain("vite/define/no-runtime-object-define");
    expect(viteRulePack.presets?.recommended).not.toContain(
      "vite/env/prefer-direct-import-meta-env-access",
    );
    expect(viteRulePack.presets?.recommended).not.toContain("vite/plugin/require-name");
    expect(viteRulePack.presets?.recommended).not.toContain("vite/worker/no-node-api-in-worker");
  });

  test("reports define diagnostics from Vite config", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noUnusedDefine, noUntypedDefine, noRuntimeObjectDefine, noSecretDefine],
      files: {
        "vite.config.ts": `import { defineConfig } from 'vite'
export default defineConfig({
  define: {
    __UNUSED__: true,
    __UNTYPED__: JSON.stringify('ok'),
    __OBJECT__: { enabled: true },
    __SECRET_TOKEN__: JSON.stringify(process.env.SECRET_TOKEN),
  },
})`,
        "src/main.ts": `console.log(__UNTYPED__)`,
      },
    });

    expect(result.diagnostics.map(({ ruleId, why }) => `${ruleId}: ${why}`).sort()).toEqual([
      'vite/define/no-runtime-object-define: Vite define "__OBJECT__" uses a non-primitive replacement value.',
      'vite/define/no-secret-define: Vite define "__SECRET_TOKEN__" looks like a secret and will be bundled into client code.',
      'vite/define/no-untyped-define: Vite define global "__OBJECT__" is not declared in a project .d.ts file.',
      'vite/define/no-untyped-define: Vite define global "__SECRET_TOKEN__" is not declared in a project .d.ts file.',
      'vite/define/no-untyped-define: Vite define global "__UNTYPED__" is not declared in a project .d.ts file.',
      'vite/define/no-untyped-define: Vite define global "__UNUSED__" is not declared in a project .d.ts file.',
      'vite/define/no-unused-define: Vite define constant "__OBJECT__" is configured but never referenced.',
      'vite/define/no-unused-define: Vite define constant "__SECRET_TOKEN__" is configured but never referenced.',
      'vite/define/no-unused-define: Vite define constant "__UNUSED__" is configured but never referenced.',
    ]);
  });

  test("reports env, asset, worker, plugin, and HMR diagnostics", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [
        noUntypedEnv,
        noClientSecretPattern,
        preferDirectImportMetaEnvAccess,
        noPublicSrcImport,
        noSrcAbsolutePublicUrl,
        noDynamicNewUrl,
        requireWorkerUrlPattern,
        noDynamicWorkerUrl,
        noBrowserGlobalInSsrEntry,
        preferTransformFilter,
        requirePluginName,
        requireDisposeForSideEffects,
      ],
      files: {
        "vite.config.ts": `export default {
  plugins: [{
    transform(code) {
      return code
    }
  }]
}`,
        "src/main.ts": `import logo from '/public/logo.svg'
const { VITE_API_URL } = import.meta.env
console.log(import.meta.env.VITE_SECRET_TOKEN)
const asset = new URL(name, import.meta.url)
fetch(new URL(name, import.meta.url))
const worker = new Worker('./worker.ts')
const other = new Worker(new URL('./other-worker.ts', foo.bar))
import.meta.hot.accept()
window.addEventListener('resize', () => {})
console.log('/src/assets/logo.svg', logo, asset, worker, other, VITE_API_URL)`,
        "src/App.vue": `<template><iframe src="/src/assets/frame.html"></iframe></template>`,
        "src/entry-server.ts": `export function render() {
  return document.documentElement.outerHTML
}`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId).sort()).toEqual([
      "vite/assets/no-dynamic-new-url",
      "vite/assets/no-public-src-import",
      "vite/assets/no-src-absolute-public-url",
      "vite/env/no-client-secret-pattern",
      "vite/env/no-untyped-env",
      "vite/env/prefer-direct-import-meta-env-access",
      "vite/hmr/require-dispose-for-side-effects",
      "vite/plugin/prefer-transform-filter",
      "vite/plugin/require-name",
      "vite/ssr/no-browser-global-in-ssr-entry",
      "vite/worker/require-worker-url-pattern",
      "vite/worker/require-worker-url-pattern",
    ]);
  });

  test("treats modules that import Vite as plugin sources", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [preferTransformFilter, requirePluginName],
      files: {
        "packages/env/src/vite.ts": `import { loadEnv } from 'vite'
import type { Plugin } from 'vite'
export function env(): Plugin {
  return {
    name: 'env',
    transform(code) {
      return code.includes('@env') ? code.replace('@env', JSON.stringify(loadEnv('', ''))) : undefined
    },
  }
}
export function unnamed(): Plugin {
  return { load(id) { return id === 'virtual:x' ? '' : undefined } }
}
export function wrap(plugin: Plugin, load?: Function): Plugin {
  return {
    name: 'wrap:' + plugin.name,
    ...(load ? { load(...args) { return load.call(this, ...args) } } : {}),
    ...{ resolveId(id) { return id } },
  }
}`,
        "packages/env/src/options.ts": `import type { UserConfig } from 'vite'
export function shared(config: UserConfig, transform?: (code: string) => string) {
  return { config, transform, load: config.root }
}`,
        "packages/env/src/runtime.ts": `export const hooks = {
  transform(code) { return code },
  load() {},
}`,
      },
    });

    expect(
      result.diagnostics.map((item) => `${item.ruleId} ${item.file.split("/").pop()}`).sort(),
    ).toEqual(["vite/plugin/prefer-transform-filter vite.ts", "vite/plugin/require-name vite.ts"]);
  });

  test("needs plugin evidence for hook-shaped objects in modules that import Vite", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [preferTransformFilter, requirePluginName],
      files: {
        "packages/kit/src/shorthand.ts": `import type { Plugin } from 'vite'
const transform = (code: string) => code
export default { name: 'shorthand', transform } satisfies Plugin`,
        "packages/kit/src/annotated.ts": `import type { Plugin } from 'vite'
function load(id: string) { return id }
export const plugin: Plugin = { load: load as Plugin['load'] }`,
        "packages/kit/src/array.ts": `import type { PluginOption } from 'vite'
export function plugins(): PluginOption[] {
  return [{ resolveId(id) { return id } }]
}`,
        "packages/kit/src/filtered.ts": `import type { Plugin } from 'vite'
const transform = ((code: string, id: string) => (id ? code : code)) as Plugin['transform']
export default { "name": 'filtered', transform }`,
        "packages/kit/src/local-type.ts": `import type { UserConfig } from 'vite'
type Plugin = { transform(code: string): string }
export const lifecycle: Plugin = { transform(code) { return code } }
export const config: UserConfig = {}`,
        "packages/kit/src/aliased.ts": `import type { PluginOption as Option } from 'vite'
export const plugin: Option = { load(id) { return id } }`,
        "packages/kit/src/inline.ts": `import { loadEnv } from 'vite'
export const plugin: import('vite').Plugin = { load(id) { return loadEnv(id, '') } }`,
        "packages/kit/src/imported.ts": `import type { Plugin } from 'vite'
import { load } from './load'
export const plugin: Plugin = { load }`,
        "packages/kit/src/asserted.ts": `import type { Plugin } from 'vite'
export default <Plugin>{ resolveId(id) { return id } }`,
        "packages/kit/src/extended.ts": `import type { Plugin } from 'vite'
interface EnvPlugin extends Plugin { api: string }
export function env(): EnvPlugin { return { api: '', load(id) { return id } } }`,
        "packages/kit/src/lifecycle.ts": `import type { UserConfig } from 'vite'
export function lifecycle(config: UserConfig) {
  const transform = config.root
  return {
    load() { return config },
    transform(code: string) { return code },
    resolveId: { handler: transform },
    generateBundle: transform,
  }
}`,
      },
    });

    expect(
      result.diagnostics.map((item) => `${item.ruleId} ${item.file.split("/").pop()}`).sort(),
    ).toEqual([
      "vite/plugin/prefer-transform-filter shorthand.ts",
      "vite/plugin/require-name aliased.ts",
      "vite/plugin/require-name annotated.ts",
      "vite/plugin/require-name array.ts",
      "vite/plugin/require-name asserted.ts",
      "vite/plugin/require-name extended.ts",
      "vite/plugin/require-name imported.ts",
      "vite/plugin/require-name inline.ts",
    ]);
  });

  test("narrows noisy Vite recommended heuristics", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noDynamicNewUrl, requireDisposeForSideEffects, noNodeApiInWorker, requirePluginName],
      files: {
        "src/cli.ts": `const scanArgs = {
  path: { type: 'positional' },
  config: { type: 'boolean' },
}`,
        "src/node/plugins/worker.ts": `import fs from 'node:fs'
export function plugin() {
  return 'worker plugin'
}`,
        "src/node/server/hmr.ts": `const text = "import.meta.hot.accept("
globalThis.addEventListener?.('message', () => {})`,
        "src/main.ts": `fetch(new URL(route, import.meta.url))`,
        "workspace-aliases.ts": `import { fileURLToPath } from 'node:url'
function workspacePath(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url))
}`,
      },
    });

    expect(result.diagnostics).toHaveLength(0);
  });

  test("still reports real worker and dynamic asset issues", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noDynamicNewUrl, noNodeApiInWorker],
      files: {
        "src/main.ts": `const heroAsset = new URL(assetName, import.meta.url)
const worker = new Worker(new URL('./bad-worker.ts', import.meta.url))
console.log(heroAsset, worker)`,
        "src/bad-worker.ts": `import path from 'node:path'
console.log(path.sep)`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId).sort()).toEqual([
      "vite/assets/no-dynamic-new-url",
      "vite/worker/no-node-api-in-worker",
    ]);
  });

  test("allows public JSON imports used as static SSR data", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noPublicSrcImport],
      files: {
        "src/main.ts": `import data from '/public/agent-results.json'
import nuxtData from '~~/public/agent-results.json'
import rawData from '../public/results.json?raw'
console.log(data, nuxtData, rawData)`,
        "public/agent-results.json": `{"ok":true}`,
        "public/results.json": `{"ok":true}`,
      },
    });

    expect(result.diagnostics).toHaveLength(0);
  });

  test("still reports public media imports", async () => {
    const result = await runProjectFixture({
      framework: "nuxt",
      rules: [noPublicSrcImport],
      files: {
        "src/main.ts": `import logo from '~~/public/logo.svg'
console.log(logo)`,
        "public/logo.svg": `<svg />`,
      },
    });

    expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
      "vite/assets/no-public-src-import",
    ]);
  });

  test("reports env prefix and dev server filesystem risks", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [
        noEmptyEnvPrefix,
        noBroadEnvPrefix,
        noClientSecretPattern,
        noDisabledFsStrict,
        noBroadFsAllow,
      ],
      files: {
        "vite.config.ts": `export default {
  envPrefix: ['', 'APP_'],
  server: {
    fs: {
      strict: false,
      allow: ['/', '/Users/maxi']
    }
  }
}`,
        "src/main.ts": `console.log(import.meta.env.APP_SECRET)`,
      },
    });

    expect(result.diagnostics.map(({ ruleId, why }) => `${ruleId}: ${why}`).sort()).toEqual([
      'vite/env/no-broad-env-prefix: Vite envPrefix "" is broad enough to expose unrelated variables.',
      'vite/env/no-broad-env-prefix: Vite envPrefix "APP_" is broad enough to expose unrelated variables.',
      "vite/env/no-client-secret-pattern: import.meta.env.APP_SECRET looks like a secret and may be exposed to the browser.",
      'vite/env/no-empty-env-prefix: Vite envPrefix: "" exposes every environment variable to client code.',
      'vite/server/no-broad-fs-allow: Vite server.fs.allow entry "/" is broader than a project path.',
      'vite/server/no-broad-fs-allow: Vite server.fs.allow entry "/Users/maxi" is broader than a project path.',
      "vite/server/no-disabled-fs-strict: Vite dev server filesystem strict mode is disabled.",
    ]);
  });
});
