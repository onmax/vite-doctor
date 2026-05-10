import { z } from "zod";

export default {
  name: "doctor_report",
  title: "Nuxt Doctor Report",
  description: "Explains how to run a Nuxt Doctor MCP report from an installed Nuxt project.",
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
