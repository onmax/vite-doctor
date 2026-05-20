import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/cli.ts", "src/module.ts", "src/rules/index.ts"],
  exports: true,
  format: ["esm"],
});
