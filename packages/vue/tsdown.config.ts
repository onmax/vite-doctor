import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/cli.ts", "src/rules.ts"],
  exports: true,
  format: ["esm"],
});
