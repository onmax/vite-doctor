export {
  createRule,
  defineDoctorExtension,
  defineDoctorPluginApi,
  defineRulePack,
  RESERVED_DIAGNOSTIC_CODE_PREFIXES,
} from "./core/primitives.js";
export type {
  DoctorExtension,
  DoctorExtensionApi,
  DoctorExtensionInput,
  DoctorExtensionLoader,
  DoctorPluginApi,
  DoctorRule,
  ProjectInfo,
  ProjectInventoryContributor,
  RuleContext,
  RuleMeta,
  RulePack,
  RuleReportMetadata,
  RuleVisitor,
  RuntimeEvidenceContributor,
  SourceFileHandle,
  SourceRange,
} from "./core/primitives.js";
export { defineExtensionDiagnostics as defineDoctorDiagnostics } from "./core/diagnostics.js";
export type {
  DefineDoctorDiagnosticsOptions,
  DoctorDiagnosticCodeEntry,
  DoctorDiagnosticHandle,
  DoctorDiagnosticParams,
  DoctorDiagnosticRegistry,
} from "./core/diagnostics.js";
