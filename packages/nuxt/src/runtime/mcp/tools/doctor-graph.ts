import { mcpToolContracts, type DoctorReportInput } from "../contract.js";
import { getNuxtDoctorMcpContext } from "../context.js";
import { runNuxtDoctorMcpReport } from "../doctor.js";
import { jsonToolResult } from "../results.js";

const contract = mcpToolContracts.graph;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.runtimeDescription,
  annotations: contract.annotations,
  inputSchema: contract.inputSchema,
  async handler(options: DoctorReportInput) {
    const result = await runNuxtDoctorMcpReport(getNuxtDoctorMcpContext(), {
      ...options,
      analyses: "graph",
    });
    return jsonToolResult({ graph: result.graph, phases: result.phases });
  },
};
