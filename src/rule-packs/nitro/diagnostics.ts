import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const nitroDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "NITRO0001", ruleId: "nitro/context/no-navigateto-in-nitro" },
  { code: "NITRO0002", ruleId: "nitro/context/no-usenuxtapp-in-nitro" },
  { code: "NITRO0003", ruleId: "nitro/request/prefer-assert-method" },
  { code: "NITRO0004", ruleId: "nitro/request/prefer-get-request-ip" },
  { code: "NITRO0005", ruleId: "nitro/request/prefer-validated-body" },
  { code: "NITRO0006", ruleId: "nitro/request/prefer-validated-query" },
  { code: "NITRO0007", ruleId: "nitro/request/prefer-validated-router-params" },
  { code: "NITRO0008", ruleId: "nitro/runtime/require-event-runtime-config-in-server" },
  { code: "NITRO0009", ruleId: "nitro/server/no-browser-api" },
  { code: "NITRO0010", ruleId: "nitro/server/no-client-composables" },
  { code: "NITRO0011", ruleId: "nitro/server/prefer-event-fetch" },
]);

export const diagnostics = nitroDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = nitroDiagnosticRegistry.codesByRuleId;
