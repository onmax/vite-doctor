import { defineDoctorDiagnostics } from "./diagnostics.js";

export const coreDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "DOC9999", ruleId: "doctor/external-rule-diagnostic" },
  { code: "DOC0001", ruleId: "workspace/dead-code/circular-dependency" },
  { code: "DOC0002", ruleId: "workspace/dead-code/duplicate-export" },
  { code: "DOC0003", ruleId: "workspace/dead-code/unlisted-dependency" },
  { code: "DOC0004", ruleId: "workspace/dead-code/unresolved-import" },
  { code: "DOC0005", ruleId: "workspace/dead-code/unused-dependency" },
  { code: "DOC0006", ruleId: "workspace/dead-code/unused-export" },
  { code: "DOC0007", ruleId: "workspace/dead-code/unused-file" },
  { code: "DOC0008", ruleId: "workspace/dead-code/unused-type-export" },
  { code: "DOC0009", ruleId: "workspace/duplication/exact-clone" },
  { code: "DOC0010", ruleId: "workspace/health/high-cyclomatic-complexity" },
  { code: "DOC0011", ruleId: "workspace/health/high-fan-out" },
  { code: "DOC0012", ruleId: "doctor/internal/duplicate-diagnostic-code", docs: false },
  { code: "DOC0013", ruleId: "doctor/internal/missing-diagnostic-code", docs: false },
  { code: "DOC0014", ruleId: "doctor/internal/missing-diagnostic-name", docs: false },
  { code: "DOC0015", ruleId: "doctor/rule-pack/missing-recommended-preset", docs: false },
  { code: "DOC0016", ruleId: "doctor/config/invalid-extends-entry", docs: false },
  { code: "DOC0017", ruleId: "doctor/config/unknown-rule-pack", docs: false },
  { code: "DOC0018", ruleId: "doctor/config/unknown-preset", docs: false },
  { code: "DOC0019", ruleId: "doctor/config/invalid-rule-severity", docs: false },
  { code: "DOC0020", ruleId: "doctor/config/invalid-rule-config", docs: false },
  { code: "DOC0021", ruleId: "doctor/internal/missing-diagnostic-fix", docs: false },
  { code: "DOC0022", ruleId: "doctor/inventory/unresolved-runtime" },
  { code: "DOC0023", ruleId: "doctor/rule-pack/duplicate-name", docs: false },
  { code: "DOC0024", ruleId: "doctor/config/ambiguous-rule-pack-alias", docs: false },
  { code: "DOC0025", ruleId: "doctor/baseline/invalid-input", docs: false },
  { code: "DOC0032", ruleId: "doctor/baseline/stale-fingerprint-scheme" },
  { code: "DOC0039", ruleId: "doctor/baseline/resolved-entries" },
  { code: "DOC0026", ruleId: "doctor/extension/duplicate-contributor-name", docs: false },
  { code: "DOC0027", ruleId: "doctor/extension/invalid-diagnostic-code", docs: false },
  { code: "DOC0028", ruleId: "doctor/extension/reserved-diagnostic-prefix", docs: false },
  { code: "DOC0029", ruleId: "doctor/extension/unloadable-host-entry", docs: false },
  { code: "DOC0030", ruleId: "doctor/rule/undeclared-cross-file-report", docs: false },
  { code: "DOC0031", ruleId: "doctor/config/unused-suppression" },
  { code: "DOC0033", ruleId: "doctor/inventory/empty-sfc" },
  { code: "DOC0034", ruleId: "doctor/rule/unknown-hook", docs: false },
  { code: "DOC0035", ruleId: "doctor/config/invalid-override", docs: false },
  { code: "DOC0036", ruleId: "doctor/inline/unused-suppression" },
  { code: "DOC0037", ruleId: "doctor/inline/unknown-suppression-rule" },
  { code: "DOC0038", ruleId: "doctor/config/default-config-file" },
]);

export const diagnostics = coreDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = coreDiagnosticRegistry.codesByRuleId;

/**
 * Doctor-owned Rule IDs that a Doctor Run reports as Diagnostics, so Rule config can set their
 * severity or turn them off.
 */
export const reportedDoctorRuleIds: ReadonlySet<string> = new Set([
  "doctor/inventory/unresolved-runtime",
  "doctor/baseline/stale-fingerprint-scheme",
  "doctor/baseline/resolved-entries",
  "doctor/config/unused-suppression",
  "doctor/inventory/empty-sfc",
  "doctor/inline/unused-suppression",
  "doctor/inline/unknown-suppression-rule",
  "doctor/config/default-config-file",
]);
