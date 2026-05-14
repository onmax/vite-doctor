import { z } from "zod";

export const mcpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const doctorReportInputSchema = {
  rules: z.string().optional().describe("Comma-separated rule ids to run."),
  severity: z.enum(["error", "warn", "info"]).optional().describe("Minimum severity to report."),
  changed: z.boolean().optional().describe("Only scan files changed in git."),
  since: z.string().optional().describe("Git revision used with changed scans."),
  baseline: z.string().optional().describe("Baseline file path relative to the project root."),
  newOnly: z.boolean().optional().describe("Suppress diagnostics already present in the baseline."),
  types: z.boolean().optional().describe("Enable or disable type-aware checks."),
  analyses: z.string().optional().describe("Comma-separated analysis phases to run."),
  coverage: z.string().optional().describe("Coverage file path relative to the project root."),
  runtimeEvidence: z
    .string()
    .optional()
    .describe("Runtime evidence file path relative to the project root."),
  confidenceMin: z.string().optional().describe("Minimum diagnostic confidence to include."),
  profile: z.boolean().optional().describe("Include timing information in the report."),
};

export interface DoctorReportInput {
  rules?: string;
  severity?: "error" | "warn" | "info";
  changed?: boolean;
  since?: string;
  baseline?: string;
  newOnly?: boolean;
  types?: boolean;
  analyses?: string;
  coverage?: string;
  runtimeEvidence?: string;
  confidenceMin?: string;
  profile?: boolean;
}

export const doctorExplainRuleInputSchema = {
  ruleId: z.string().describe("The Nuxt Doctor rule id to explain."),
};

export const mcpToolContracts = {
  report: {
    name: "doctor_report",
    title: "Nuxt Doctor Report",
    runtimeDescription:
      "Runs a read-only Nuxt Doctor scan for the current Nuxt project and returns the structured JSON report.",
    docsDescription: "Explains how to run a Nuxt Doctor MCP report from an installed Nuxt project.",
    annotations: mcpToolAnnotations,
    inputSchema: doctorReportInputSchema,
  },
  rules: {
    name: "doctor_rules",
    title: "Nuxt Doctor Rules",
    runtimeDescription:
      "Lists Nuxt Doctor rule metadata, including rule packs added by the current Nuxt app.",
    docsDescription: "Lists Nuxt Doctor rule metadata published with the docs site.",
    annotations: mcpToolAnnotations,
  },
  explainRule: {
    name: "doctor_explain_rule",
    title: "Explain Nuxt Doctor Rule",
    runtimeDescription: "Returns remediation context and metadata for a Nuxt Doctor rule id.",
    docsDescription: "Returns published metadata for a Nuxt Doctor rule id.",
    annotations: mcpToolAnnotations,
    inputSchema: doctorExplainRuleInputSchema,
  },
  deadCode: {
    name: "doctor_dead_code",
    title: "Nuxt Doctor Dead Code",
    runtimeDescription:
      "Runs Nuxt Doctor structural dead-code analysis for the current Nuxt project.",
    docsDescription: "Explains Nuxt Doctor dead-code analysis.",
    annotations: mcpToolAnnotations,
    inputSchema: doctorReportInputSchema,
  },
  duplicates: {
    name: "doctor_duplicates",
    title: "Nuxt Doctor Duplicates",
    runtimeDescription: "Runs Nuxt Doctor duplication analysis for the current Nuxt project.",
    docsDescription: "Explains Nuxt Doctor duplication analysis.",
    annotations: mcpToolAnnotations,
    inputSchema: doctorReportInputSchema,
  },
  health: {
    name: "doctor_health",
    title: "Nuxt Doctor Health",
    runtimeDescription: "Runs Nuxt Doctor health analysis for the current Nuxt project.",
    docsDescription: "Explains Nuxt Doctor health analysis.",
    annotations: mcpToolAnnotations,
    inputSchema: doctorReportInputSchema,
  },
  graph: {
    name: "doctor_graph",
    title: "Nuxt Doctor Graph",
    runtimeDescription: "Returns Nuxt Doctor workspace graph summary for the current Nuxt project.",
    docsDescription: "Explains Nuxt Doctor graph analysis.",
    annotations: mcpToolAnnotations,
    inputSchema: doctorReportInputSchema,
  },
  refs: {
    name: "doctor_refs",
    title: "Nuxt Doctor References",
    runtimeDescription:
      "Returns reference-oriented Nuxt Doctor structural analysis for the current project.",
    docsDescription: "Explains Nuxt Doctor reference analysis.",
    annotations: mcpToolAnnotations,
    inputSchema: doctorReportInputSchema,
  },
  explainDiagnostic: {
    name: "doctor_explain_diagnostic",
    title: "Explain Nuxt Doctor Diagnostic",
    runtimeDescription: "Explains a Nuxt Doctor diagnostic fingerprint or rule id.",
    docsDescription: "Explains Nuxt Doctor diagnostics.",
    annotations: mcpToolAnnotations,
    inputSchema: doctorExplainRuleInputSchema,
  },
} as const;
