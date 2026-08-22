import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/config.ts",
    "src/plugin.ts",
    "src/nuxt.ts",
    "src/rules.ts",
    "src/rule-packs/vite/index.ts",
    "src/rule-packs/vite/rules/index.ts",
    "src/rule-packs/vue/index.ts",
    "src/rule-packs/vue/rules.ts",
    "src/rule-packs/nitro/index.ts",
    "src/rule-packs/nitro/rules.ts",
    "src/rule-packs/nuxt/index.ts",
    "src/rule-packs/nuxt/module.ts",
    "src/rule-packs/nuxt/rules/index.ts",
    "src/rule-packs/typescript/index.ts",
    "src/rule-packs/typescript/rules/index.ts",
  ],
  exports: {
    bin: {
      "nuxt-doctor": "src/cli.ts",
      "vite-doctor": "src/cli.ts",
    },
  },
  format: ["esm"],
});
