import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const piniaDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "PINIA0001", ruleId: "pinia/stores/unique-store-id" },
  { code: "PINIA0002", ruleId: "pinia/stores/store-name-matches-id" },
  { code: "PINIA0003", ruleId: "pinia/stores/no-circular-setup-state-read" },
  { code: "PINIA0004", ruleId: "pinia/state/no-action-bypass" },
  { code: "PINIA0005", ruleId: "pinia/state/no-store-destructure" },
  { code: "PINIA0006", ruleId: "pinia/stores/no-module-scope-store" },
  { code: "PINIA0007", ruleId: "pinia/stores/no-unreturned-setup-state" },
]);

export const diagnostics = piniaDiagnosticRegistry.diagnostics;
