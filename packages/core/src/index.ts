import type { DoctorRunOptions } from "./config.js";
import type { DoctorRunResult } from "./primitives.js";
import { parseSourceFiles } from "./internal/facts.js";
import {
  buildGraphPhase,
  buildTypeGraphPhase,
  runDuplicationPhase,
  runFileRules,
  runGraphRules,
  runHealthPhase,
  runManifestRules,
  runTypeRules,
} from "./internal/rule-execution.js";
import { cleanCache, createScanSession, markSession, runPhase } from "./internal/scan-session.js";
import { applyPolicyFilters, applyRequestedFixes, createResult } from "./internal/diagnostics.js";

export * from "./primitives.js";
export * from "./config.js";
export * from "./reports.js";
export {
  createNuxtProjectInventory,
  matchesNuxtScanRoot,
  normalizeNuxtModuleSources,
  relativeNuxtScanRoot,
} from "./internal/nuxt-inventory.js";
export { default as vueRulePack } from "./rules/vue.js";
export { default as viteRulePack } from "./rules/vite.js";
export { cleanCache };

export async function runDoctor(options: DoctorRunOptions = {}): Promise<DoctorRunResult> {
  const session = await createScanSession(options);
  await runPhase(session, "parseFileFacts", () => parseSourceFiles(session));
  await runPhase(session, "fileRules", () => runFileRules(session));
  await runPhase(session, "manifestRules", () => runManifestRules(session));
  await runPhase(session, "workspaceGraph", () => buildGraphPhase(session));
  await runPhase(session, "graphRules", () => runGraphRules(session));
  await runPhase(session, "typeGraph", () => buildTypeGraphPhase(session));
  await runPhase(session, "typeRules", () => runTypeRules(session));
  await runPhase(session, "duplication", () => runDuplicationPhase(session));
  await runPhase(session, "health", () => runHealthPhase(session));
  await runPhase(session, "fixPlanning", () => applyRequestedFixes(session));
  applyPolicyFilters(session);

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
  );
  markSession(session, "score", started);
  return result;
}
