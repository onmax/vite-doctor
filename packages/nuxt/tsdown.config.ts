import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/module.ts",
    "src/cli.ts",
    "src/bin.ts",
    "src/rules/index.ts",
    "src/runtime/mcp/tools/doctor-report.ts",
    "src/runtime/mcp/tools/doctor-rules.ts",
    "src/runtime/mcp/tools/doctor-explain-rule.ts",
    "src/runtime/mcp/tools/doctor-dead-code.ts",
    "src/runtime/mcp/tools/doctor-duplicates.ts",
    "src/runtime/mcp/tools/doctor-health.ts",
    "src/runtime/mcp/tools/doctor-graph.ts",
    "src/runtime/mcp/tools/doctor-refs.ts",
    "src/runtime/mcp/tools/doctor-explain-diagnostic.ts",
  ],
  exports: true,
  format: ["esm"],
});
