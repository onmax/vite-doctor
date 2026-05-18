import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/rules.ts"],
  exports: true,
  format: ["esm"],
});
