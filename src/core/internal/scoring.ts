import type { DoctorConfig } from "../config.js";
import type { Diagnostic } from "../primitives.js";
import { DEFAULT_WEIGHTS } from "./utils.js";

export function scoreDiagnostics(diagnostics: Diagnostic[], config: DoctorConfig) {
  const weights = { ...DEFAULT_WEIGHTS, ...config.score?.weights };
  const summary = {
    blocker: diagnostics.filter((d) => d.severity === "blocker").length,
    error: diagnostics.filter((d) => d.severity === "error").length,
    warn: diagnostics.filter((d) => d.severity === "warn").length,
    info: diagnostics.filter((d) => d.severity === "info").length,
    fixable: diagnostics.filter((d) => d.fix?.kind === "safe").length,
  };
  const penalty = diagnosticPenalty(summary, weights);
  const categories: Record<string, Diagnostic[]> = {};
  for (const diagnostic of diagnostics) {
    categories[diagnostic.category] ??= [];
    categories[diagnostic.category].push(diagnostic);
  }
  const categoryScores = Object.fromEntries(
    Object.entries(categories).map(([category, items]) => {
      const categorySummary = {
        blocker: items.filter((d) => d.severity === "blocker").length,
        error: items.filter((d) => d.severity === "error").length,
        warn: items.filter((d) => d.severity === "warn").length,
        info: items.filter((d) => d.severity === "info").length,
      };
      return [category, Math.max(0, 100 - diagnosticPenalty(categorySummary, weights))];
    }),
  );
  return {
    score: Math.max(0, 100 - penalty),
    categoryScores,
    summary,
  };
}

function diagnosticPenalty(
  summary: { blocker: number; error: number; warn: number; info: number },
  weights: typeof DEFAULT_WEIGHTS,
) {
  const blockerPenalty = Math.min(100, summary.blocker * weights.blocker);
  const errorPenalty = Math.min(summary.blocker ? 100 : 60, summary.error * weights.error);
  const warnPenalty = Math.min(
    summary.error || summary.blocker ? 30 : 25,
    summary.warn * weights.warn,
  );
  const infoPenalty = Math.min(10, summary.info * weights.info);
  return Math.min(100, blockerPenalty + errorPenalty + warnPenalty + infoPenalty);
}
