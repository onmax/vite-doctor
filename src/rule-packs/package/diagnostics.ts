import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const packageDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "PKG0001", ruleId: "package/no-phantom-dependencies" },
  { code: "PKG0002", ruleId: "package/no-phantom-dependencies" },
]);

export const diagnostics = packageDiagnosticRegistry.diagnostics;
