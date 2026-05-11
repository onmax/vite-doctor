import rulesReport from "../../../public/rules/all.json" with { type: "json" };
import { mcpToolContracts } from "../../../../packages/nuxt/src/runtime/mcp/contract.js";

const contract = mcpToolContracts.explainRule;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.docsDescription,
  annotations: contract.annotations,
  inputSchema: contract.inputSchema,
  async handler({ ruleId }: { ruleId: string }) {
    const rule = rulesReport.rules.find((rule) => rule.id === ruleId) ?? null;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ rule }, null, 2) }],
    };
  },
};
