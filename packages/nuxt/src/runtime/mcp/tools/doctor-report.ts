import { z } from "zod";
import { getNuxtDoctorMcpContext } from "../context.js";
import { runNuxtDoctorMcpReport } from "../doctor.js";
import { jsonToolResult } from "../results.js";

export default {
  name: "doctor_report",
  title: "Nuxt Doctor Report",
  description:
    "Runs a read-only Nuxt Doctor scan for the current Nuxt project and returns the structured JSON report.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    rules: z.string().optional().describe("Comma-separated rule ids to run."),
    severity: z.enum(["error", "warn", "info"]).optional().describe("Minimum severity to report."),
    changed: z.boolean().optional().describe("Only scan files changed in git."),
    since: z.string().optional().describe("Git revision used with changed scans."),
    baseline: z.string().optional().describe("Baseline file path relative to the project root."),
    newOnly: z
      .boolean()
      .optional()
      .describe("Suppress diagnostics already present in the baseline."),
    types: z.boolean().optional().describe("Enable or disable type-aware checks."),
    profile: z.boolean().optional().describe("Include timing information in the report."),
  },
  async handler(options: {
    rules?: string;
    severity?: "error" | "warn" | "info";
    changed?: boolean;
    since?: string;
    baseline?: string;
    newOnly?: boolean;
    types?: boolean;
    profile?: boolean;
  }) {
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
    });
  },
};
