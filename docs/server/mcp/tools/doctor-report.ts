import { mcpToolContracts } from "../../../../packages/nuxt/src/runtime/mcp/contract.js";

const contract = mcpToolContracts.report;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.docsDescription,
  annotations: contract.annotations,
  inputSchema: contract.inputSchema,
  async handler() {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error:
                "The public documentation Worker cannot scan an arbitrary project filesystem. Install nuxt-doctor/module in your Nuxt app and connect your MCP client to that app's /mcp endpoint to receive the full structured doctor_report JSON.",
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  },
};
