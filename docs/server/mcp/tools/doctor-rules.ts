import { mcpToolContracts } from "../../utils/mcp-contracts.js";
import { getRuleReports } from "../../../rules/source.js";

const contract = mcpToolContracts.rules;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.docsDescription,
  annotations: contract.annotations,
  async handler() {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(getRuleReports().all, null, 2) }],
    };
  },
};
