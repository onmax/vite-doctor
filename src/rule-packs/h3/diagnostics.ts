import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const h3DiagnosticRegistry = defineDoctorDiagnostics([
  { code: "H30001", ruleId: "h3/migration/no-removed-exports" },
  { code: "H30002", ruleId: "h3/migration/prefer-redirect-response" },
  { code: "H30003", ruleId: "h3/migration/prefer-with-base" },
  { code: "H30004", ruleId: "h3/errors/no-http-error-masking" },
  { code: "H30005", ruleId: "h3/request/prefer-assert-method" },
  { code: "H30006", ruleId: "h3/request/prefer-get-request-ip" },
  { code: "H30007", ruleId: "h3/request/prefer-validated-body" },
  { code: "H30008", ruleId: "h3/request/prefer-validated-query" },
  { code: "H30009", ruleId: "h3/request/prefer-validated-router-params" },
  { code: "H30010", ruleId: "h3/response/no-event-first-arg" },
  { code: "H30011", ruleId: "h3/response/no-discarded-response" },
  { code: "H30012", ruleId: "h3/response/no-prepared-status-with-response" },
  { code: "H30013", ruleId: "h3/response/no-html-plain-string" },
  { code: "H30014", ruleId: "h3/errors/no-numeric-create-error" },
  { code: "H30015", ruleId: "h3/errors/no-throw-plain-object" },
  { code: "H30016", ruleId: "h3/body/no-double-body-read" },
  { code: "H30017", ruleId: "h3/security/session-password-too-short" },
  { code: "H30018", ruleId: "h3/migration/no-ignored-hooks" },
  { code: "H30019", ruleId: "h3/migration/no-removed-router-api" },
  { code: "H30020", ruleId: "h3/middleware/no-exact-path-use" },
]);

export const diagnostics = h3DiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = h3DiagnosticRegistry.codesByRuleId;
