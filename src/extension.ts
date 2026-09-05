export { createRule, defineDoctorExtension, defineRulePack } from "./core/primitives.js";
export type {
  DoctorExtension,
  DoctorExtensionApi,
  DoctorRule,
  ProjectInventoryContributor,
  RuleContext,
  RuleMeta,
  RulePack,
  RuleVisitor,
  RuntimeEvidenceContributor,
  SourceFileHandle,
  SourceRange,
} from "./core/primitives.js";
export { defineDoctorDiagnostics } from "./core/diagnostics.js";
export type {
  DoctorDiagnosticCodeEntry,
  DoctorDiagnosticHandle,
  DoctorDiagnosticParams,
  DoctorDiagnosticRegistry,
} from "./core/diagnostics.js";
