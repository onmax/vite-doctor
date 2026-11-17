import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const packageDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "PKG0001", ruleId: "package/no-phantom-dependencies" },
  { code: "PKG0002", ruleId: "package/no-phantom-dependencies" },
  { code: "PKG0003", ruleId: "package/no-required-optional-peer" },
  { code: "PKG0005", ruleId: "package/no-pinned-singleton" },
  { code: "PKG0006", ruleId: "package/no-pinned-singleton" },
  { code: "PKG0007", ruleId: "package/no-unforwarded-peer" },
  { code: "PKG0008", ruleId: "package/no-duplicate-singleton" },
]);

export const diagnostics = packageDiagnosticRegistry.diagnostics;
