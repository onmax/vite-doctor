import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const piniaDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "PINIA0001", ruleId: "pinia/stores/unique-store-id" },
  { code: "PINIA0002", ruleId: "pinia/stores/store-name-matches-id" },
]);

export const diagnostics = piniaDiagnosticRegistry.diagnostics;
