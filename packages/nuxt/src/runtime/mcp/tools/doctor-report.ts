import { mcpToolContracts, type DoctorReportInput } from "../contract.js";
import { getNuxtDoctorMcpContext } from "../context.js";
import { runNuxtDoctorMcpReport } from "../doctor.js";
import { jsonToolResult } from "../results.js";

const contract = mcpToolContracts.report;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.runtimeDescription,
  annotations: contract.annotations,
  inputSchema: contract.inputSchema,
  async handler(options: DoctorReportInput) {
    const result = await runNuxtDoctorMcpReport(getNuxtDoctorMcpContext(), options);
    return jsonToolResult({
      version: result.version,
      framework: result.framework,
      root: result.root,
      score: result.score,
      categoryScores: result.categoryScores,
      summary: result.summary,
      diagnostics: result.diagnostics,
      suppressedDiagnostics: result.suppressedDiagnostics,
      timings: result.timings,
      phases: result.phases,
      graph: result.graph,
    });
  },
};
