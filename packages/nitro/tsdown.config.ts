import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/rules.ts"],
  exports: true,
  format: ["esm"],
});
