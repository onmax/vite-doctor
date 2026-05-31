import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vue-doctor\/core/, /^nitro-doctor/, /^nuxt-doctor/, /^vue-doctor/],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/nuxt-cli.ts",
    "src/plugin.ts",
    "src/nuxt.ts",
    "src/rules.ts",
  ],
  exports: {
    bin: {
      "nuxt-doctor": "src/nuxt-cli.ts",
      "vite-doctor": "src/cli.ts",
    },
  },
  format: ["esm"],
});
