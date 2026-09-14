import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const shadcnDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "SHAD0001", ruleId: "shadcn/no-restyle" },
  { code: "SHAD0002", ruleId: "shadcn/no-raw-colors" },
  { code: "SHAD0003", ruleId: "shadcn/no-arbitrary-values" },
  { code: "SHAD0004", ruleId: "shadcn/no-inline-styles" },
  { code: "SHAD0005", ruleId: "shadcn/require-static-classes" },
  { code: "SHAD0006", ruleId: "shadcn/no-unknown-classes" },
]);

export const diagnostics = shadcnDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = shadcnDiagnosticRegistry.codesByRuleId;
