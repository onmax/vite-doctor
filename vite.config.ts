import { configDefaults, defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

export default defineConfig({
  pack: {
    deps: { neverBundle: ["eslint-plugin-vue", "oxc-parser", "typescript"] },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["**/dist/**", "**/.vue-doctor/**"] },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/.vue-doctor/**",
      "docs/app/**",
      "docs/server/**",
      "docs/examples/**",
      "tests/fixtures/**",
    ],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ["src/rule-packs/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: ["node:fs", "fs", "node:fs/promises", "fs/promises"].map((name) => ({
                name,
                message: "Rules read files through ctx.fs so Doctor can track their inputs.",
              })),
              patterns: [
                {
                  group: [
                    "**/core/internal/runtime-graph.js",
                    "**/core/internal/source-inventory.js",
                  ],
                  importNames: ["isNuxtManifestConfigurationCurrent", "selectScanFiles"],
                  message: "This helper reads files Doctor cannot track as Rule inputs.",
                },
              ],
            },
          ],
          "no-restricted-properties": [
            "error",
            { object: "ts", property: "sys", message: "Rules read files through ctx.fs." },
            {
              object: "process",
              property: "env",
              message: "Rule results must not depend on the environment.",
            },
            {
              object: "process",
              property: "cwd",
              message: "Rules resolve paths from ctx.project.root.",
            },
          ],
        },
      },
      {
        // The Nuxt module runs inside the Nuxt host and writes the Doctor manifest; it is not a Rule.
        files: ["src/rule-packs/nuxt/module.ts"],
        rules: { "no-restricted-imports": "off", "no-restricted-properties": "off" },
      },
    ],
  },
  run: {
    cache: true,
  },
  test: {
    // Agent worktrees under .claude/ are full repo checkouts; collecting them duplicates and breaks the suite.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    setupFiles: [fileURLToPath(new URL("./tests/setup.ts", import.meta.url))],
  },
});
