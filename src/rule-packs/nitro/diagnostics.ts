import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const nitroDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "NITRO0001", ruleId: "nitro/context/no-navigateto-in-nitro" },
  { code: "NITRO0002", ruleId: "nitro/context/no-usenuxtapp-in-nitro" },
  { code: "NITRO0008", ruleId: "nitro/runtime/require-event-runtime-config-in-server" },
  { code: "NITRO0009", ruleId: "nitro/server/no-browser-api" },
  { code: "NITRO0010", ruleId: "nitro/server/no-client-composables" },
  { code: "NITRO0011", ruleId: "nitro/server/prefer-event-fetch" },
  { code: "NITRO0012", ruleId: "nitro/request/prefer-route-method-suffix" },
  { code: "NITRO0013", ruleId: "nitro/runtime/no-event-runtime-config-in-server" },
  { code: "NITRO0014", ruleId: "nitro/migration/no-v2-imports" },
  { code: "NITRO0019", ruleId: "nitro/routes/require-default-handler" },
  { code: "NITRO0020", ruleId: "nitro/routes/require-default-handler" },
  { code: "NITRO0021", ruleId: "nitro/structure/prefer-server-utils" },
  { code: "NITRO0022", ruleId: "nitro/structure/prefer-server-utils" },
  { code: "NITRO0023", ruleId: "nitro/cache/no-module-scope-response-cache" },
  { code: "NITRO0024", ruleId: "nitro/cloudflare/no-unguarded-als-enterwith" },
  { code: "NITRO0025", ruleId: "nitro/config/require-absolute-generated-paths" },
  { code: "NITRO0026", ruleId: "nitro/runtime/no-process-env-in-server" },
  { code: "NITRO0027", ruleId: "nitro/h3/prefer-nitro-h3" },
  { code: "NITRO0028", ruleId: "nitro/dependencies/declare-nitro" },
  { code: "NITRO0029", ruleId: "nitro/cache/require-varies-for-header-read" },
  { code: "NITRO0030", ruleId: "nitro/middleware/no-implicit-response" },
  { code: "NITRO0031", ruleId: "nitro/routes/no-shadowed-file-handler" },
  { code: "NITRO0032", ruleId: "nitro/runtime/no-runtime-config-in-response" },
  { code: "NITRO0033", ruleId: "nitro/handler/require-waituntil-for-background-work" },
  { code: "NITRO0034", ruleId: "nitro/storage/no-undeclared-mount" },
  { code: "NITRO0035", ruleId: "nitro/state/no-request-data-in-module-state" },
]);

export const diagnostics = nitroDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = nitroDiagnosticRegistry.codesByRuleId;
