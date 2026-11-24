import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const piniaDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "PINIA0001", ruleId: "pinia/stores/unique-store-id" },
  { code: "PINIA0002", ruleId: "pinia/stores/store-name-matches-id" },
  { code: "PINIA0003", ruleId: "pinia/stores/no-circular-setup-state-read" },
]);

export const diagnostics = piniaDiagnosticRegistry.diagnostics;
