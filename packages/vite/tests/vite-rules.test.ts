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
} from "../src/rules.ts";
import { runProjectFixture } from "../../core/src/testkit.ts";

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

    expect(result.diagnostics.map((item) => item.ruleId).sort()).toEqual([
      "vite/define/no-runtime-object-define",
      "vite/define/no-secret-define",
      "vite/define/no-untyped-define",
      "vite/define/no-unused-define",
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
        "src/App.vue": `<template><img src="/src/assets/logo.svg"></template>`,
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

  test("narrows noisy Vite recommended heuristics", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noDynamicNewUrl, requireDisposeForSideEffects, noNodeApiInWorker, requirePluginName],
      files: {
        "packages/vite/src/cli.ts": `const scanArgs = {
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

  test("allows public json imports used as static data", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noPublicSrcImport],
      files: {
        "src/main.ts": `import data from '/public/agent-results.json'
console.log(data)`,
        "public/agent-results.json": `{"ok":true}`,
      },
    });

    expect(result.diagnostics).toHaveLength(0);
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

    expect(result.diagnostics.map((item) => item.ruleId).sort()).toEqual([
      "vite/env/no-broad-env-prefix",
      "vite/env/no-client-secret-pattern",
      "vite/env/no-empty-env-prefix",
      "vite/server/no-broad-fs-allow",
      "vite/server/no-disabled-fs-strict",
    ]);
  });
});
