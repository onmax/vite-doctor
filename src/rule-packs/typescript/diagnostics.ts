import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const typescriptDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "TS0001", ruleId: "typescript/evidence/no-chained-type-assertions" },
  { code: "TS0002", ruleId: "typescript/evidence/no-object-parameters" },
  { code: "TS0003", ruleId: "typescript/evidence/no-unknown-type-aliases" },
  { code: "TS0004", ruleId: "typescript/evidence/no-caller-chosen-result-type" },
  { code: "TS0005", ruleId: "typescript/boundaries/no-unvalidated-deserialization" },
  {
    code: "TS0006",
    ruleId: "typescript/style/no-conditional-empty-object-spread",
  },
  { code: "TS0007", ruleId: "typescript/strict/no-runtime-typeof" },
  {
    code: "TS0008",
    ruleId: "typescript/strict/require-safety-comment-for-type-assertion",
  },
]);

export const diagnostics = typescriptDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = typescriptDiagnosticRegistry.codesByRuleId;
