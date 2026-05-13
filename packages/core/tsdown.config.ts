import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/config.ts",
    "src/reports.ts",
    "src/testkit.ts",
    "src/vite-rules.ts",
    "src/vue-rules.ts",
    "src/internal/cli.ts",
    "src/internal/diagnostic-policy.ts",
    "src/internal/nuxt-inventory.ts",
    "src/internal/rule-runner.ts",
    "src/internal/source-inventory.ts",
  ],
  exports: true,
  format: ["esm"],
});
