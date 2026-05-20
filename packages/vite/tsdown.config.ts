import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vue-doctor\/core/, /^nitro-doctor/, /^nuxt-doctor/, /^vue-doctor/],
    onlyBundle: false,
  },
  dts: true,
  entry: ["src/index.ts", "src/cli.ts", "src/plugin.ts", "src/nuxt.ts", "src/rules.ts"],
  exports: true,
  format: ["esm"],
});
