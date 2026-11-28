import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const designSystemDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "DS0001", ruleId: "design-system/no-restyle" },
  { code: "DS0002", ruleId: "design-system/no-raw-colors" },
  { code: "DS0003", ruleId: "design-system/no-arbitrary-values" },
  { code: "DS0004", ruleId: "design-system/no-inline-styles" },
  { code: "DS0005", ruleId: "design-system/require-static-classes" },
  { code: "DS0006", ruleId: "design-system/no-unknown-classes" },
  { code: "DS0007", ruleId: "design-system/prefer-project-component" },
  { code: "DS0008", ruleId: "design-system/limit-per-view" },
  { code: "DS0009", ruleId: "design-system/unreadable-contract" },
]);

export const diagnostics = designSystemDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = designSystemDiagnosticRegistry.codesByRuleId;
