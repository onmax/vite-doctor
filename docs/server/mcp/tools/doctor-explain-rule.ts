import { mcpToolContracts } from "../../../../packages/nuxt/src/runtime/mcp/contract.js";
import { getRuleReports } from "../../../rules/source.js";

const contract = mcpToolContracts.explainRule;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.docsDescription,
  annotations: contract.annotations,
  inputSchema: contract.inputSchema,
  async handler({ ruleId }: { ruleId: string }) {
    const rule = getRuleReports().all.rules.find((rule) => rule.id === ruleId) ?? null;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ rule }, null, 2) }],
    };
  },
};
