import { createReport, reportStatus } from "./core/index.js";
import type { DoctorExtension, DoctorExtensionInput, DoctorRunOptions } from "./core/index.js";
import { runViteDoctor, shouldFailDoctorRun } from "./doctor.js";

/** Structured-cloneable Doctor Run input prepared by the Vite Plugin Surface. */
export interface SurfaceRunInput {
  options: Omit<DoctorRunOptions, "extensions">;
  vite: { inventory: Record<string, unknown>; evidence: Record<string, unknown> };
}

export interface SurfaceRunOutcome {
  report: string;
  shouldFail: boolean;
  hasFindings: boolean;
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
  return { report, shouldFail, hasFindings };
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
