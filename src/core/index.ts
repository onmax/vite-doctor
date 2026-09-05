import type { DoctorRunOptions } from "./config.js";
import type { DoctorRunResult } from "./primitives.js";
import { parseSourceFiles } from "./internal/facts.js";
import {
  buildGraphPhase,
  runDuplicationPhase,
  runFileRules,
  runGraphRules,
  runHealthPhase,
  runManifestRules,
} from "./internal/rule-execution.js";
import { cleanCache, createScanSession, markSession, runPhase } from "./internal/scan-session.js";
import {
  applyPolicyFilters,
  applyRequestedFixes,
  createResult,
  reportRuntimeInventoryUnknown,
} from "./internal/diagnostics.js";

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
export { cleanCache };
export { evaluatePackActivation, evaluateRuleApplicability } from "./internal/applicability.js";
export { detectProject } from "./internal/project.js";

export async function runDoctor(options: DoctorRunOptions = {}): Promise<DoctorRunResult> {
  const requestedFixes = Boolean(options.fix || options.unsafeFix || options.structuralReview);
  const initial = await executeDoctorRun(
    requestedFixes && options.updateBaseline ? { ...options, updateBaseline: false } : options,
  );
  if (!requestedFixes || (!initial.fixes?.edits && !options.updateBaseline)) return initial;

  const verified = await executeDoctorRun({
    ...options,
    fix: false,
    unsafeFix: false,
    structuralReview: false,
  });
  return { ...verified, fixes: initial.fixes };
}

async function executeDoctorRun(options: DoctorRunOptions): Promise<DoctorRunResult> {
  const session = await createScanSession(options);
  reportRuntimeInventoryUnknown(session);
  await runPhase(session, "parseFileFacts", () => parseSourceFiles(session));
  await runPhase(session, "fileRules", () => runFileRules(session));
  await runPhase(session, "manifestRules", () => runManifestRules(session));
  await runPhase(session, "workspaceGraph", () => buildGraphPhase(session));
  await runPhase(session, "graphRules", () => runGraphRules(session));
  await runPhase(session, "duplication", () => runDuplicationPhase(session));
  await runPhase(session, "health", () => runHealthPhase(session));
  applyPolicyFilters(session);
  let fixes: ReturnType<typeof applyRequestedFixes> = undefined;
  await runPhase(session, "fixPlanning", () => {
    fixes = applyRequestedFixes(session);
  });

  const started = performance.now();
  const result = createResult(
    session.project,
    session.root,
    session.diagnostics,
    session.suppressedDiagnostics,
    session.config,
    options.profile ? session.timings : undefined,
    options.profile ? session.phases : undefined,
    session.graph,
    session.gitChanges
      ? {
          mode: "changed",
          base: session.gitChanges.base,
          files: session.files.length,
          deletedFiles: session.gitChanges.files.filter((file) => file.kind === "deleted").length,
        }
      : { mode: "all", files: session.files.length },
  );
  result.fixes = fixes;
  markSession(session, "score", started);
  return result;
}
