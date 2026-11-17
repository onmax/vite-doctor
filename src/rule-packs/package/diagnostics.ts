import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const packageDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "PKG0001", ruleId: "package/no-phantom-dependencies" },
  { code: "PKG0002", ruleId: "package/no-phantom-dependencies" },
  { code: "PKG0003", ruleId: "package/no-required-optional-peer" },
  { code: "PKG0004", ruleId: "package/optional-peer-import-in-try" },
]);

export const diagnostics = packageDiagnosticRegistry.diagnostics;
