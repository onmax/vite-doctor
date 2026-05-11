import rulesReport from "../../../public/rules/all.json" with { type: "json" };
import { mcpToolContracts } from "../../../../packages/nuxt/src/runtime/mcp/contract.js";

const contract = mcpToolContracts.rules;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.docsDescription,
  annotations: contract.annotations,
  async handler() {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rulesReport, null, 2) }],
    };
  },
};
