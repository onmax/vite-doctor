import type { DoctorRunOptions } from "./config.js";
import type { DoctorRunResult, ProjectInfo } from "./primitives.js";
import { parseSourceFiles } from "./internal/facts.js";
import {
  buildGraphPhase,
  runDuplicationPhase,
  runFileRules,
  runGraphRules,
  runHealthPhase,
  runManifestRules,
} from "./internal/rule-execution.js";
import {
  cacheStatus,
  cleanCache,
  createScanSession,
  markSession,
  persistScanCache,
  runPhase,
} from "./internal/scan-session.js";
import {
  applyPolicyFilters,
  applyRequestedFixes,
  createResult,
  reportRuntimeInventoryUnknown,
} from "./internal/diagnostics.js";
import { reportRuntimeFrameworkDiagnostics } from "./internal/runtime-diagnostics.js";

export * from "./primitives.js";
export * from "./config.js";
export * from "./diagnostics.js";
export * from "./diagnostic-registry.js";
export * from "./diagnostic-code-map.js";
export * from "./reports.js";
export {
  createNuxtProjectInventory,
  matchesNuxtScanRoot,
  normalizeNuxtModuleSources,
  relativeNuxtScanRoot,
} from "./internal/nuxt-inventory.js";
export { cacheStatus, cleanCache };
export type { CacheRunStats, CacheStatus } from "./internal/cache-store.js";
export { evaluatePackActivation, evaluateRuleApplicability } from "./internal/applicability.js";
export { detectProject } from "./internal/project.js";
export { FRAMEWORK_DIAGNOSTICS_EVIDENCE } from "./internal/runtime-diagnostics.js";

export async function runDoctor(
  options: DoctorRunOptions = {},
  fullRunWhen?: (project: ProjectInfo) => boolean,
): Promise<DoctorRunResult> {
  const requestedFixes = Boolean(options.fix || options.unsafeFix || options.structuralReview);
  const initial = await executeDoctorRun(
    requestedFixes && options.updateBaseline ? { ...options, updateBaseline: false } : options,
    fullRunWhen,
  );
  if (!requestedFixes || (!initial.fixes?.edits && !options.updateBaseline)) return initial;

  const verified = await executeDoctorRun(
    { ...options, fix: false, unsafeFix: false, structuralReview: false },
    fullRunWhen,
  );
  return { ...verified, fixes: initial.fixes };
}

async function executeDoctorRun(
  input: DoctorRunOptions,
  fullRunWhen?: (project: ProjectInfo) => boolean,
): Promise<DoctorRunResult> {
  const session = await createScanSession(input, fullRunWhen);
  const { options } = session;
  reportRuntimeInventoryUnknown(session);
  reportRuntimeFrameworkDiagnostics(session);
  await runPhase(session, "parseFileFacts", () => parseSourceFiles(session));
  await runPhase(session, "fileRules", () => runFileRules(session));
  await runPhase(session, "manifestRules", () => runManifestRules(session));
  await runPhase(session, "workspaceGraph", () => buildGraphPhase(session));
  await runPhase(session, "graphRules", () => runGraphRules(session));
  await runPhase(session, "duplication", () => runDuplicationPhase(session));
  await runPhase(session, "health", () => runHealthPhase(session));
  await applyPolicyFilters(session);
  let fixes: ReturnType<typeof applyRequestedFixes> = undefined;
  await runPhase(session, "fixPlanning", () => {
    fixes = applyRequestedFixes(session);
  });
  await runPhase(session, "cache", () => persistScanCache(session));

  const started = performance.now();
  const analyzed = [...session.files, ...session.testFiles];
  const result = createResult(
    session.project,
    session.root,
    session.diagnostics,
    session.suppressedDiagnostics,
    session.config,
    options.profile ? session.timings : undefined,
    options.profile ? session.phases : undefined,
    session.graphSummary,
    session.gitChanges
      ? {
          mode: "changed",
          base: session.gitChanges.base,
          files: analyzed.filter((file) => file.reportEligibility).length,
          deletedFiles: session.gitChanges.files.filter((file) => file.kind === "deleted").length,
        }
      : options.affectedFiles
        ? { mode: "affected", files: analyzed.filter((file) => file.reportEligibility).length }
        : { mode: "all", files: analyzed.length },
  );
  result.fixes = fixes;
  result.extends = options.extends ?? session.config.extends;
  result.workspacePackages = session.workspaceActivations;
  result.rulePacks = session.rulePacks;
  const reported = new Set(result.diagnostics.map((diagnostic) => diagnostic.ruleId));
  result.ruleTitles = Object.fromEntries(
    session.registry.rules
      .filter((rule) => reported.has(rule.meta.id))
      .map((rule) => [rule.meta.id, rule.meta.title]),
  );
  if (options.profile) {
    result.ruleTimings = [...session.ruleTimings]
      .map(([rule, timing]) => ({ rule, ms: Math.round(timing.ms), files: timing.files }))
      .sort((left, right) => right.ms - left.ms || left.rule.localeCompare(right.rule));
  }
  markSession(session, "score", started);
  return result;
}
