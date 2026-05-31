import { defineDoctorDiagnostics } from "./core/diagnostics.js";

export const viteDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "VITE0001", ruleId: "vite/assets/no-dynamic-new-url" },
  { code: "VITE0002", ruleId: "vite/assets/no-public-src-import" },
  { code: "VITE0003", ruleId: "vite/assets/no-src-absolute-public-url" },
  { code: "VITE0004", ruleId: "vite/define/no-runtime-object-define" },
  { code: "VITE0005", ruleId: "vite/define/no-secret-define" },
  { code: "VITE0006", ruleId: "vite/define/no-untyped-define" },
  { code: "VITE0007", ruleId: "vite/define/no-unused-define" },
  { code: "VITE0008", ruleId: "vite/env/no-broad-env-prefix" },
  { code: "VITE0009", ruleId: "vite/env/no-client-secret-pattern" },
  { code: "VITE0010", ruleId: "vite/env/no-empty-env-prefix" },
  { code: "VITE0011", ruleId: "vite/env/no-untyped-env" },
  { code: "VITE0012", ruleId: "vite/env/prefer-direct-import-meta-env-access" },
  { code: "VITE0013", ruleId: "vite/hmr/require-dispose-for-side-effects" },
  { code: "VITE0014", ruleId: "vite/plugin/prefer-transform-filter" },
  { code: "VITE0015", ruleId: "vite/plugin/require-name" },
  { code: "VITE0016", ruleId: "vite/server/no-broad-fs-allow" },
  { code: "VITE0017", ruleId: "vite/server/no-disabled-fs-strict" },
  { code: "VITE0018", ruleId: "vite/ssr/no-browser-global-in-ssr-entry" },
  { code: "VITE0019", ruleId: "vite/worker/no-dynamic-worker-url" },
  { code: "VITE0020", ruleId: "vite/worker/no-node-api-in-worker" },
  { code: "VITE0021", ruleId: "vite/worker/require-worker-url-pattern" },
]);

export const diagnostics = viteDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = viteDiagnosticRegistry.codesByRuleId;
