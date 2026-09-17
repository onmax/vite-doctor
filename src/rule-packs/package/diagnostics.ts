import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const packageDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "PKG0003", ruleId: "package/no-required-optional-peer" },
]);

export const diagnostics = packageDiagnosticRegistry.diagnostics;
