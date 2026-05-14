import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vue-doctor\/core/],
    onlyBundle: false,
  },
  dts: true,
  entry: ["src/index.ts", "src/cli.ts", "src/plugin.ts", "src/nuxt.ts"],
  exports: true,
  format: ["esm"],
});
