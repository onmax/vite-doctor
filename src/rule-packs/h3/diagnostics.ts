import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const h3DiagnosticRegistry = defineDoctorDiagnostics([
  { code: "H30001", ruleId: "h3/migration/no-removed-send" },
  { code: "H30002", ruleId: "h3/migration/prefer-redirect-response" },
  { code: "H30003", ruleId: "h3/migration/prefer-with-base" },
  { code: "H30004", ruleId: "h3/errors/no-http-error-masking" },
  { code: "H30005", ruleId: "h3/request/prefer-assert-method" },
  { code: "H30006", ruleId: "h3/request/prefer-get-request-ip" },
  { code: "H30007", ruleId: "h3/request/prefer-validated-body" },
  { code: "H30008", ruleId: "h3/request/prefer-validated-query" },
  { code: "H30009", ruleId: "h3/request/prefer-validated-router-params" },
]);

export const diagnostics = h3DiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = h3DiagnosticRegistry.codesByRuleId;
