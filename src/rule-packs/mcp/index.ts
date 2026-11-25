import { defineRulePack } from "../../core/index.js";
import { readMcpServers } from "../../mcp/evidence.js";
import { mcpRecommendedRuleIds } from "./presets.js";
import { mcpRules } from "./rules/index.js";
import { MCP_PACKAGES } from "./rules/shared.js";

export * from "./rules/index.js";
export { diagnostics, mcpDiagnosticRegistry } from "./diagnostics.js";

export const mcpRulePack = defineRulePack({
  name: "vite-doctor/mcp",
  version: "0.0.0",
  activation: {
    packages: MCP_PACKAGES,
    // A server passed with --mcp-url or the plugin's `mcp` option is checked even in a repository
    // without an MCP package, such as a job that watches a deployed server.
    runtimeEvidence: (evidence) => readMcpServers(evidence).length > 0,
  },
  rules: mcpRules,
  presets: {
    recommended: mcpRecommendedRuleIds,
    strict: mcpRules.map((rule) => rule.meta.id),
  },
});

export default mcpRulePack;
