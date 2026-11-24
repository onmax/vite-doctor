import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const packageDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "PKG0001", ruleId: "package/no-phantom-dependencies" },
  { code: "PKG0002", ruleId: "package/no-phantom-dependencies" },
  { code: "PKG0003", ruleId: "package/no-required-optional-peer" },
  { code: "PKG0004", ruleId: "package/optional-peer-import-in-try" },
  { code: "PKG0005", ruleId: "package/no-pinned-singleton" },
  { code: "PKG0006", ruleId: "package/no-pinned-singleton" },
  { code: "PKG0007", ruleId: "package/no-unforwarded-peer" },
  { code: "PKG0008", ruleId: "package/no-duplicate-singleton" },
  { code: "PKG0009", ruleId: "package/no-condition-after-default" },
]);

export const diagnostics = packageDiagnosticRegistry.diagnostics;
