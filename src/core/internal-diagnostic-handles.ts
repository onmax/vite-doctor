import { defineDiagnostics } from "nostics";

export const doctorInternalDiagnostics = defineDiagnostics({
  codes: {
    DOC0012: {
      why: (params: { code: string }) => `Duplicate Doctor diagnostic code "${params.code}".`,
      fix: (params: { code: string }) =>
        `Assign a unique Diagnostic Code instead of registering "${params.code}" twice.`,
    },
    DOC0013: {
      why: (params: { ruleId: string; code?: string }) =>
        params.code
          ? `No Doctor diagnostic handle is registered for rule "${params.ruleId}" and code "${params.code}".`
          : `No Doctor diagnostic code is registered for rule "${params.ruleId}".`,
      fix: "Register a Diagnostic Code for the rule before it can report diagnostics.",
    },
    DOC0014: {
      why: (params: { ruleId: string }) =>
        `Rule "${params.ruleId}" reported a diagnostic without a nostics name/code.`,
      fix: "Report diagnostics through a registered Doctor nostics handle.",
    },
    DOC0015: {
      why: (params: { pack: string }) =>
        `Rule pack "${params.pack}" must define a non-empty recommended preset.`,
      fix: "Add at least one rule ID to the rule pack recommended preset.",
    },
    DOC0016: {
      why: (params: { entry: string }) =>
        `Invalid Config Extends entry "${params.entry}". Use "pack/preset".`,
      fix: 'Use a rule-pack-qualified preset such as "vite-doctor/vue/recommended".',
    },
    DOC0017: {
      why: (params: { entry: string; pack: string }) =>
        `Unknown Rule Pack "${params.pack}" in Config Extends entry "${params.entry}".`,
      fix: "Use an installed Rule Pack name or remove the Config Extends entry.",
    },
    DOC0018: {
      why: (params: { entry: string; pack: string; preset: string }) =>
        `Unknown Preset "${params.preset}" for Rule Pack "${params.pack}" in Config Extends entry "${params.entry}".`,
      fix: "Use a Preset exposed by the selected Rule Pack.",
    },
    DOC0019: {
      why: (params: { ruleId: string; severity: string }) =>
        `Invalid severity for rule "${params.ruleId}": ${params.severity}.`,
      fix: 'Use "blocker", "error", "warn", "info", or "off".',
    },
    DOC0020: {
      why: (params: { ruleId: string }) => `Invalid config for rule "${params.ruleId}".`,
      fix: 'Use "off", a severity string, or a [severity, options] tuple.',
    },
    DOC0021: {
      why: (params: { ruleId: string; code?: string }) =>
        params.code
          ? `Diagnostic "${params.code}" for rule "${params.ruleId}" is missing a fix.`
          : `Rule "${params.ruleId}" reported a diagnostic without a fix.`,
      fix: "Provide actionable nostics fix text for every Doctor diagnostic.",
    },
  },
});
