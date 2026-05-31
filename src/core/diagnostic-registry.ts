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
]);

export const diagnostics = coreDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = coreDiagnosticRegistry.codesByRuleId;
