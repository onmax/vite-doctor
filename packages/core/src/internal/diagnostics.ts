import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "pathe";
import MagicString from "magic-string";
import type { DoctorConfig } from "../config.js";
import type {
  Diagnostic,
  DoctorRunResult,
  DoctorSeverity,
  ProjectInfo,
  SourceFileHandle,
  WorkspaceGraph,
} from "../primitives.js";
import { applyDiagnosticPolicy } from "./diagnostic-policy.js";
import { markSession, type ScanSession } from "./scan-session.js";
import { scoreDiagnostics } from "./scoring.js";
import { VERSION, sha256 } from "./utils.js";
import { allDiagnosticCodesByRuleId, allDiagnostics } from "../diagnostic-code-map.js";
import type { Diagnostic as NosticsDiagnostic } from "nostics";

export function applyRequestedFixes(session: ScanSession): void {
  if (!session.options.fix && !session.options.unsafeFix && !session.options.structuralReview)
    return;
  const started = performance.now();
  applyFixes(session.diagnostics, {
    includeUnsafe: session.options.unsafeFix,
    includeStructuralReview: session.options.structuralReview,
  });
  markSession(session, "fix", started);
}

export function applyPolicyFilters(session: ScanSession): void {
  applySeverityFilter(session);
  const result = applyDiagnosticPolicy(session);
  session.diagnostics = result.diagnostics;
  session.suppressedDiagnostics = result.suppressedDiagnostics;
}

function applySeverityFilter(session: ScanSession): void {
  const minimum = session.options.severity;
  if (!minimum) return;
  const minRank = severityRank(minimum);
  session.diagnostics = session.diagnostics.filter(
    (diagnostic) => severityRank(diagnostic.severity) >= minRank,
  );
}

function severityRank(severity: DoctorSeverity): number {
  if (severity === "blocker") return 4;
  if (severity === "error") return 3;
  if (severity === "warn") return 2;
  return 1;
}

function applyFixes(
  diagnostics: Diagnostic[],
  options: { includeUnsafe?: boolean; includeStructuralReview?: boolean } = {},
) {
  const byFile = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.fix) continue;
    if (diagnostic.fix.kind === "suggestion") continue;
    if (diagnostic.fix.kind === "unsafe" && !options.includeUnsafe) continue;
    if (diagnostic.fix.kind === "structural-review" && !options.includeStructuralReview) continue;
    const list = byFile.get(diagnostic.file) ?? [];
    list.push(diagnostic);
    byFile.set(diagnostic.file, list);
  }
  for (const [file, items] of byFile) {
    const text = readFileSync(file, "utf8");
    const ms = new MagicString(text);
    const edits = planNonOverlappingFixes(items).sort((a, b) => b.range.start - a.range.start);
    for (const edit of edits) ms.overwrite(edit.range.start, edit.range.end, edit.text);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ms.toString());
  }
}

export function createResult(
  project: ProjectInfo,
  root: string,
  diagnostics: Diagnostic[],
  suppressedDiagnostics: Diagnostic[],
  config: DoctorConfig,
  timings?: Record<string, number>,
  phases?: Record<string, number>,
  graph?: WorkspaceGraph,
): DoctorRunResult {
  const scoring = scoreDiagnostics(diagnostics, config);
  return {
    version: VERSION,
    reportVersion: 2,
    framework: project.framework,
    root,
    score: scoring.score,
    categoryScores: scoring.categoryScores,
    summary: scoring.summary,
    diagnostics,
    suppressedDiagnostics,
    timings,
    phases,
    graph: graph
      ? {
          files: graph.files.size,
          importEdges: graph.importEdges.length,
          exportEdges: graph.exportEdges.length,
          virtualRoots: graph.virtualRoots.length,
          cycles: graph.sccs.filter((scc) => scc.length > 1).length,
        }
      : undefined,
    project,
  };
}

export function createDiagnosticFingerprint(
  root: string,
  diagnostic: Diagnostic,
  file: SourceFileHandle,
): string {
  const rel = relative(root, diagnostic.file);
  const anchor = nearestAnchor(file.text, diagnostic.range?.start ?? 0);
  const message = diagnostic.why.replace(/\s+/g, " ").replace(/['"`][^'"`]+['"`]/g, '""');
  return sha256(`${diagnostic.ruleId}:${rel}:${anchor}:${message}`);
}

export function normalizeDiagnostic(input: DoctorDiagnosticNormalizationInput): Diagnostic {
  const diagnostic = input.diagnostic;
  const code = diagnostic.name;
  if (!code) throw new Error(`Doctor diagnostic is missing a nostics name/code.`);
  return {
    ...input,
    diagnostic,
    code,
    why: diagnostic.why,
    docs: diagnostic.docs,
    sources: diagnostic.sources,
    message: diagnostic.why,
    suggestion: diagnostic.fix,
  } as Diagnostic;
}

type DoctorDiagnosticNormalizationInput = Partial<Diagnostic> & {
  diagnostic: NosticsDiagnostic;
  ruleId: string;
  severity: Diagnostic["severity"];
  category: string;
  file: string;
};

export function normalizeDiagnosticFromRuleCode(
  input: Partial<Diagnostic> & {
    ruleId: string;
    severity: Diagnostic["severity"];
    category: string;
    message?: string;
    why?: string;
    suggestion?: string;
  },
): Diagnostic {
  const code = input.code ?? allDiagnosticCodesByRuleId[input.ruleId] ?? "DOC9999";
  const why = input.why ?? input.message ?? input.diagnostic?.why ?? "Doctor diagnostic";
  const fix = input.suggestion ?? input.diagnostic?.fix ?? input.fix?.message ?? why;
  const diagnostic =
    input.diagnostic ?? allDiagnostics[code]?.report({ why, fix, sources: input.sources });
  if (!diagnostic) {
    throw new Error(`No Doctor diagnostic code registered for ${input.ruleId}.`);
  }
  return {
    ...input,
    diagnostic,
    code: diagnostic.name,
    why: diagnostic.why,
    docs: diagnostic.docs,
    sources: diagnostic.sources,
    message: diagnostic.why,
    suggestion: diagnostic.fix,
  } as Diagnostic;
}

function nearestAnchor(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const matches = [
    ...before.matchAll(
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|<([A-Z][\w.-]*)\b/g,
    ),
  ];
  const last = matches.at(-1);
  return last ? (last[1] ?? last[2] ?? last[3] ?? "file") : "file";
}

export function pushDiagnostic(
  session: ScanSession,
  diagnostic: Partial<Diagnostic> & {
    ruleId: string;
    severity: Diagnostic["severity"];
    category: string;
    message?: string;
    why?: string;
    suggestion?: string;
    file: string;
  },
): void {
  const normalized = normalizeDiagnosticFromRuleCode(diagnostic);
  session.diagnostics.push({
    ...normalized,
    fingerprint:
      normalized.fingerprint ??
      createDiagnosticFingerprint(session.root, normalized, {
        path: normalized.file,
        relativePath: relative(session.root, normalized.file),
        sourceKind: "app",
        text: readFileSyncIfExists(diagnostic.file) ?? "",
        hash: "",
        isVueSfc: false,
        project: session.project,
        matches: () => false,
        inAppDir: () => false,
        isModuleSource: () => false,
      }),
  });
}

export function defaultConfidenceForPhase(phase: Diagnostic["analysisPhase"]) {
  if (phase === "graph") return "proven";
  if (phase === "type") return "type-backed";
  if (phase === "manifest") return "manifest-backed";
  if (phase === "duplication" || phase === "health") return "heuristic-high";
  return "heuristic-medium";
}

export function evidenceKindForPhase(phase: Diagnostic["analysisPhase"]) {
  if (phase === "file") return "ast";
  if (phase === "manifest") return "manifest";
  if (phase === "graph" || phase === "workspace") return "graph";
  if (phase === "type") return "types";
  if (phase === "duplication" || phase === "health") return "facts";
  return "facts";
}

function planNonOverlappingFixes(items: Diagnostic[]) {
  const sorted = items
    .flatMap((item) => item.fix?.edits ?? [])
    .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  const planned: typeof sorted = [];
  let lastEnd = -1;
  for (const edit of sorted) {
    if (edit.range.start < lastEnd) continue;
    planned.push(edit);
    lastEnd = edit.range.end;
  }
  return planned;
}

function readFileSyncIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
