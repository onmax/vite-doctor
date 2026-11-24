import {
  createReport,
  diagnosticLocation,
  formatTextDiagnostic,
  reportStatus,
} from "./core/index.js";
import type {
  Diagnostic,
  DoctorExtension,
  DoctorExtensionInput,
  DoctorRunOptions,
  DoctorRunResult,
} from "./core/index.js";
import { nativeMatch } from "./core/internal/utils.js";
import { runViteDoctor, shouldFailDoctorRun } from "./doctor.js";
import type { SurfaceDiagnostic, SurfaceEvidenceGap } from "./plugin-delta.js";

/** Structured-cloneable Doctor Run input prepared by the Vite Plugin Surface. */
export interface SurfaceRunInput {
  options: Omit<DoctorRunOptions, "extensions">;
  vite: { inventory: Record<string, unknown>; evidence: Record<string, unknown> };
}

export interface SurfaceRunOutcome {
  report: string;
  shouldFail: boolean;
  hasFindings: boolean;
  /** The reported Diagnostics, so a serve-mode Plugin Surface can log what changed between runs. */
  diagnostics: SurfaceDiagnostic[];
  evidenceGaps: SurfaceEvidenceGap[];
  /** The run is `incomplete` for a reason other than its evidence gaps, such as an unresolved runtime. */
  runtimeIncomplete: boolean;
}

export async function runSurfaceDoctor(
  input: SurfaceRunInput,
  extensions: DoctorExtensionInput[],
): Promise<SurfaceRunOutcome> {
  const result = await runViteDoctor({
    ...input.options,
    extensions: [viteSurfaceExtension(input.vite), ...extensions],
  });
  const report = createReport(result, input.options.format).trimEnd();
  const shouldFail =
    reportStatus(result) === "incomplete" || shouldFailDoctorRun(result, input.options.maxWarnings);
  const hasFindings =
    shouldFail || result.summary.blocker > 0 || result.summary.error > 0 || result.summary.warn > 0;
  return {
    report,
    shouldFail,
    hasFindings,
    diagnostics: result.diagnostics.map((diagnostic) => surfaceDiagnostic(result, diagnostic)),
    evidenceGaps: (result.project.evidenceGaps ?? []).map((gap) => ({
      ...gap,
      id: `${gap.source}\0${gap.message}\0${gap.files.join("\0")}`,
    })),
    runtimeIncomplete:
      reportStatus({ ...result, project: { ...result.project, evidenceGaps: undefined } }) ===
      "incomplete",
  };
}

/** Rules that read Build Evidence, so they run once a client bundle exists. */
const BUILD_EVIDENCE_RULES = ["vite/build/no-node-builtin-in-client-chunk"];

/**
 * Runs the Build Evidence Rules that the surface's `rules` filter allows, after a client bundle.
 * The run before the build already reported everything else. Config and presets still decide
 * whether each Rule is on. Returns undefined when the filter leaves no Rule to run.
 */
export async function runBuildEvidenceDoctor(
  input: SurfaceRunInput,
  extensions: DoctorExtensionInput[],
): Promise<SurfaceRunOutcome | undefined> {
  const wanted = input.options.rules
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const rules = BUILD_EVIDENCE_RULES.filter(
    (rule) => !wanted?.length || wanted.some((pattern) => nativeMatch(rule, pattern)),
  );
  if (!rules.length) return undefined;
  return runSurfaceDoctor(
    { ...input, options: { ...input.options, rules: rules.join(",") } },
    extensions,
  );
}

function surfaceDiagnostic(result: DoctorRunResult, diagnostic: Diagnostic): SurfaceDiagnostic {
  const location = diagnosticLocation(result.root, diagnostic);
  return {
    id:
      diagnostic.fingerprint ??
      `${diagnostic.ruleId}\0${location}\0${diagnostic.code}\0${diagnostic.message}`,
    severity: diagnostic.severity,
    files: [diagnostic.file, ...(diagnostic.related ?? []).map((related) => related.file)],
    summary: `${diagnostic.code} ${location} ${diagnostic.message}`,
    detail: formatTextDiagnostic(result.root, diagnostic),
  };
}

function viteSurfaceExtension(vite: SurfaceRunInput["vite"]): DoctorExtension {
  return {
    name: "vite-doctor/surface-vite",
    setup(api) {
      api.registerProjectInventoryContributor({ name: "vite", contribute: () => vite.inventory });
      api.registerRuntimeEvidenceContributor({ name: "vite", contribute: () => vite.evidence });
    },
  };
}
