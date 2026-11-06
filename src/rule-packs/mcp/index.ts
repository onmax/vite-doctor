import { defineRulePack } from "../../core/index.js";
import { mcpRecommendedRuleIds } from "./presets.js";
import { mcpRules } from "./rules/index.js";
import { MCP_PACKAGES } from "./rules/shared.js";

export * from "./rules/index.js";
export { diagnostics, mcpDiagnosticRegistry } from "./diagnostics.js";

export const mcpRulePack = defineRulePack({
  name: "vite-doctor/mcp",
  version: "0.0.0",
  activation: { packages: MCP_PACKAGES },
  rules: mcpRules,
  presets: {
    recommended: mcpRecommendedRuleIds,
    strict: mcpRules.map((rule) => rule.meta.id),
  },
});

export default mcpRulePack;
