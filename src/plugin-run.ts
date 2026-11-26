import {
  FRAMEWORK_DIAGNOSTICS_EVIDENCE,
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
  RuntimeFrameworkDiagnostic,
} from "./core/index.js";
import { selectDoctorPresentation } from "./core/internal/agent-runtime.js";
import { diagnosticOccurrenceKey } from "./core/internal/diagnostic-policy.js";
import { hostImportResolvers, type HostImportResolver } from "./core/internal/host-imports.js";
import { createScanSession, fileRuleConfig } from "./core/internal/scan-session.js";
import { runViteDoctor, shouldFailDoctorRun, viteDoctorRunOptions } from "./doctor.js";
import { readMcpServers } from "./mcp/evidence.js";
import type { SurfaceDiagnostic, SurfaceEvidenceGap } from "./plugin-delta.js";
import {
  BUILD_EVIDENCE_RULE,
  buildImportChain,
  buildModuleFile,
  readBuildEvidence,
} from "./rule-packs/vite/rules/build-evidence.js";

/** Structured-cloneable Doctor Run input prepared by the Vite Plugin Surface. */
export interface SurfaceRunInput {
  options: Omit<DoctorRunOptions, "extensions">;
  vite: { inventory: Record<string, unknown>; evidence: Record<string, unknown> };
  /** Framework diagnostics the dev server's browser clients reported, contributed as Runtime Evidence. */
  frameworkDiagnostics?: RuntimeFrameworkDiagnostic[];
}

export interface SurfaceRunOutcome {
  report: string;
  shouldFail: boolean;
  hasFindings: boolean;
  warningKeys: string[];
  /** The reported Diagnostics, so a serve-mode Plugin Surface can log what changed between runs. */
  diagnostics: SurfaceDiagnostic[];
  evidenceGaps: SurfaceEvidenceGap[];
  hasMcpEvidence: boolean;
  needsHostImportResolution: boolean;
  /** The run is `incomplete` for a reason other than its evidence gaps, such as an unresolved runtime. */
  runtimeIncomplete: boolean;
}

export type SurfaceWorkerMessage =
  | { outcome: SurfaceRunOutcome }
  | { error: string }
  | { request: number; source: string; importer: string };

export type SurfaceWorkerResolution = { request: number } & (
  | { id: string | undefined }
  | { error: string }
);

export async function runSurfaceDoctor(
  input: SurfaceRunInput,
  extensions: DoctorExtensionInput[],
  resolveImport?: HostImportResolver,
): Promise<SurfaceRunOutcome> {
  let needsHostImportResolution = false;
  const evidence = { ...input.vite.evidence };
  hostImportResolvers.set(
    evidence,
    resolveImport ??
      (async () => {
        needsHostImportResolution = true;
        return undefined;
      }),
  );
  const result = await runViteDoctor(
    surfaceDoctorOptions({ ...input, vite: { ...input.vite, evidence } }, extensions),
    true,
  );
  const { format, reader } = await selectDoctorPresentation(input.options.format);
  const report = createReport(result, format, {
    surface: "plugin",
    runOptions: input.options,
    reader,
  }).trimEnd();
  const shouldFail =
    reportStatus(result) === "incomplete" || shouldFailDoctorRun(result, input.options.maxWarnings);
  const hasFindings =
    shouldFail || result.summary.blocker > 0 || result.summary.error > 0 || result.summary.warn > 0;
  return {
    report,
    shouldFail,
    hasFindings,
    warningKeys:
      input.options.maxWarnings === undefined
        ? []
        : result.diagnostics
            .filter((diagnostic) => diagnostic.severity === "warn")
            .map((diagnostic) =>
              diagnostic.ruleId === BUILD_EVIDENCE_RULE && diagnostic.fingerprint
                ? diagnostic.fingerprint
                : diagnosticOccurrenceKey(diagnostic),
            ),
    diagnostics: result.diagnostics.map((diagnostic) => surfaceDiagnostic(result, diagnostic)),
    evidenceGaps: (result.project.evidenceGaps ?? []).map((gap) => ({
      ...gap,
      // A gap with an instance keeps its identity while its reason changes.
      id: JSON.stringify(
        gap.instanceKey ? [gap.source, gap.instanceKey] : [gap.source, gap.message, gap.files],
      ),
    })),
    hasMcpEvidence: readMcpServers(result.project.runtimeEvidence).length > 0,
    needsHostImportResolution,
    runtimeIncomplete:
      reportStatus({ ...result, project: { ...result.project, evidenceGaps: undefined } }) ===
      "incomplete",
  };
}

function surfaceDoctorOptions(input: SurfaceRunInput, extensions: DoctorExtensionInput[]) {
  return { ...input.options, extensions: [viteSurfaceExtension(input), ...extensions] };
}

/** Without maps, consider files on the import chain, not exact diagnostic ranges. */
export async function hasEnabledBuildEvidenceCandidate(
  input: SurfaceRunInput,
  extensions: DoctorExtensionInput[],
  candidateIds: ReadonlySet<string>,
): Promise<boolean> {
  const evidence = readBuildEvidence(input.vite.evidence);
  if (!evidence) return false;
  const options = surfaceDoctorOptions(input, extensions);
  const session = await createScanSession(
    await viteDoctorRunOptions({ ...options, rules: BUILD_EVIDENCE_RULE, mcp: undefined }),
  );
  if (!session.enabledRules.some((rule) => rule.meta.id === BUILD_EVIDENCE_RULE)) return false;
  const files = new Map(session.files.map((file) => [file.path, file]));
  return evidence.environments.some(
    (environment) =>
      environment.consumer === "client" &&
      [...candidateIds].some((id) => {
        const file = buildModuleFile(evidence, id);
        const candidate = file && files.get(file);
        if (!candidate || !fileRuleConfig(session, BUILD_EVIDENCE_RULE, candidate.path).enabled)
          return false;
        if (!session.scopedReport || candidate.reportEligibility) return true;
        return buildImportChain(environment, id)?.some((importer) => {
          const path = buildModuleFile(evidence, importer);
          return path !== undefined && Boolean(files.get(path)?.reportEligibility);
        });
      }),
  );
}

/**
 * Runs only the Build Evidence Rule, after a client bundle. The run before the build already
 * reported everything else. Config and presets still decide whether the Rule is on.
 */
export async function runBuildEvidenceDoctor(
  input: SurfaceRunInput,
  extensions: DoctorExtensionInput[],
): Promise<SurfaceRunOutcome> {
  return runSurfaceDoctor(
    { ...input, options: { ...input.options, rules: BUILD_EVIDENCE_RULE, mcp: undefined } },
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

function viteSurfaceExtension({ vite, frameworkDiagnostics }: SurfaceRunInput): DoctorExtension {
  return {
    name: "vite-doctor/surface-vite",
    setup(api) {
      api.registerProjectInventoryContributor({ name: "vite", contribute: () => vite.inventory });
      api.registerRuntimeEvidenceContributor({ name: "vite", contribute: () => vite.evidence });
      if (frameworkDiagnostics?.length)
        api.registerRuntimeEvidenceContributor({
          name: FRAMEWORK_DIAGNOSTICS_EVIDENCE,
          contribute: () => ({ reports: frameworkDiagnostics }),
        });
    },
  };
}
