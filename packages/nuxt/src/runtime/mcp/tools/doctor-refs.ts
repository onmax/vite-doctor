import { mcpToolContracts, type DoctorReportInput } from "../contract.js";
import { getNuxtDoctorMcpContext } from "../context.js";
import { runNuxtDoctorMcpReport } from "../doctor.js";
import { jsonToolResult } from "../results.js";

const contract = mcpToolContracts.refs;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.runtimeDescription,
  annotations: contract.annotations,
  inputSchema: contract.inputSchema,
  async handler(options: DoctorReportInput) {
    const result = await runNuxtDoctorMcpReport(getNuxtDoctorMcpContext(), {
      ...options,
      analyses: "dead-code,graph",
    });
    return jsonToolResult({
      diagnostics: result.diagnostics.filter((item) =>
        item.ruleId.startsWith("workspace/dead-code/"),
      ),
      graph: result.graph,
    });
  },
};
