import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "pathe";
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
import { codeForRuleId, diagnosticForCode } from "../diagnostics.js";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import type { Diagnostic as NosticsDiagnostic } from "nostics";

export interface AppliedFixes {
  files: number;
  edits: number;
  skipped: number;
}

export function applyRequestedFixes(session: ScanSession): AppliedFixes | undefined {
  if (!session.options.fix && !session.options.unsafeFix && !session.options.structuralReview)
    return undefined;
  const started = performance.now();
  const applied = applyFixes(session.diagnostics, {
    includeUnsafe: session.options.unsafeFix,
    includeStructuralReview: session.options.structuralReview,
  });
  markSession(session, "fix", started);
  return applied;
}

export function applyPolicyFilters(session: ScanSession): void {
  applyReportEligibility(session);
  applySeverityFilter(session);
  const result = applyDiagnosticPolicy(session);
  session.diagnostics = result.diagnostics;
  session.suppressedDiagnostics = result.suppressedDiagnostics;
}

export function applyReportEligibility(session: ScanSession): void {
  if (!session.options.changed && !session.options.since) return;
  const eligibility = new Map(
    session.files.map((file) => [file.path, file.reportEligibility] as const),
  );
  const sources = new Map(session.handles.map((handle) => [handle.path, handle.text] as const));
  session.diagnostics = session.diagnostics.filter((diagnostic) => {
    const fileEligibility = eligibility.get(diagnostic.file);
    if (!fileEligibility) return false;
    if (!diagnostic.range) return false;
    const endLine = diagnosticEndLine(diagnostic.range, sources.get(diagnostic.file));
    return fileEligibility.ranges.some(
      (range) => diagnostic.range!.line <= range.endLine && endLine >= range.startLine,
    );
  });
}

function diagnosticEndLine(range: NonNullable<Diagnostic["range"]>, source?: string): number {
  if (!source || range.end <= range.start) return range.line;
  const newlines = source.slice(range.start, range.end - 1).match(/\n/g)?.length ?? 0;
  return range.line + newlines;
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
): AppliedFixes {
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
  const applied: AppliedFixes = { files: 0, edits: 0, skipped: 0 };
  for (const [file, items] of byFile) {
    const text = readFileSync(file, "utf8");
    const ms = new MagicString(text);
    const candidates = items.flatMap((item) => item.fix?.edits ?? []);
    const edits = planNonOverlappingFixes(items).sort((a, b) => b.range.start - a.range.start);
    applied.skipped += candidates.length - edits.length;
    if (!edits.length) continue;
    for (const edit of edits) ms.overwrite(edit.range.start, edit.range.end, edit.text);
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.vite-doctor-${process.pid}-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, ms.toString(), { mode: statSync(file).mode });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
    applied.files++;
    applied.edits += edits.length;
  }
  return applied;
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
  scope: DoctorRunResult["scope"] = { mode: "all", files: 0 },
): DoctorRunResult {
  const scoring = scoreDiagnostics(diagnostics, config);
  return {
    version: VERSION,
    reportVersion: 3,
    framework: project.framework,
    root,
    scope,
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
  if (!code) throw doctorInternalDiagnostics.DOC0014({ ruleId: input.ruleId });
  if (!diagnostic.fix) throw doctorInternalDiagnostics.DOC0021({ ruleId: input.ruleId, code });
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
  const code = input.code ?? codeForRuleId(allDiagnosticCodesByRuleId, input.ruleId) ?? "DOC9999";
  const why = input.why ?? input.message ?? input.diagnostic?.why ?? "Doctor diagnostic";
  const fix = input.suggestion ?? input.diagnostic?.fix ?? input.fix?.message;
  if (!fix) throw doctorInternalDiagnostics.DOC0021({ ruleId: input.ruleId, code });
  const diagnostic =
    input.diagnostic ??
    diagnosticForCode(allDiagnostics, code)?.({ why, fix, sources: input.sources });
  if (!diagnostic) {
    throw doctorInternalDiagnostics.DOC0013({ ruleId: input.ruleId, code });
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
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|(\{[^}\n]*\}|\[[^\]\n]*\]))|<([A-Z][\w.-]*)\b/g,
    ),
  ];
  const last = matches.at(-1);
  return last ? (last[1] ?? last[2] ?? last[3] ?? last[4] ?? "file") : "file";
}

export function pushDiagnostic(
  session: ScanSession,
  diagnostic: Partial<Diagnostic> & {
    ruleId: string;
    severity: Diagnostic["severity"];
    category: string;
    message?: string;
    why?: string;
    suggestion: string;
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

export function reportRuntimeInventoryUnknown(session: ScanSession): void {
  const expected =
    session.project.framework === "nuxt"
      ? ["nuxt", "nitro", "h3"]
      : session.project.framework === "nitro"
        ? ["nitro", "h3"]
        : session.project.framework === "vue"
          ? ["vue"]
          : [];
  const unresolved = expected
    .map(
      (runtime) =>
        session.project.runtimeGraph?.packages[runtime as "nuxt" | "nitro" | "h3" | "vue"],
    )
    .filter((item) => item?.state === "unknown");
  const details = [
    ...unresolved.map(
      (item) => `${item?.owner} -> ${item?.runtime}: ${item?.reason ?? "unresolved"}`,
    ),
    ...(session.project.nuxtCompatibility?.state === "unknown"
      ? [`Nuxt compatibility: ${session.project.nuxtCompatibility.reason ?? "unresolved"}`]
      : []),
  ];
  if (!details.length) return;
  const runtimeFix =
    "Install project dependencies and run Doctor from the target project package. If the project uses Yarn PnP, run Doctor through Yarn so its loader is active.";
  const compatibilityFix =
    "Make the effective future.compatibilityVersion statically provable in nuxt.config, or run pnpm nuxt doctor so the Nuxt integration can record the resolved value.";
  const compatibilityUnknown = session.project.nuxtCompatibility?.state === "unknown";
  pushDiagnostic(session, {
    ruleId: "doctor/inventory/unresolved-runtime",
    severity: "warn",
    category: "inventory",
    file:
      unresolved.length || !compatibilityUnknown
        ? resolve(session.root, "package.json")
        : (session.project.nuxtCompatibility?.file ?? resolve(session.root, "package.json")),
    why: `Doctor could not resolve the governing runtime graph: ${details.join("; ")}`,
    suggestion: [
      unresolved.length ? runtimeFix : undefined,
      compatibilityUnknown ? compatibilityFix : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    evidence: [
      ...unresolved.map((item) => ({
        kind: "manifest" as const,
        summary: `${item?.owner} -> ${item?.runtime} is unresolved.`,
        file: item?.packageJsonPath,
      })),
      ...(session.project.nuxtCompatibility?.state === "unknown"
        ? [
            {
              kind: "manifest" as const,
              summary: "Nuxt compatibility behavior is unresolved.",
              file: session.project.nuxtCompatibility?.file ?? session.project.nuxt?.manifestPath,
            },
          ]
        : []),
    ],
    confidence: "manifest-backed",
    analysisPhase: "manifest",
  });
}

export function defaultConfidenceForPhase(phase: Diagnostic["analysisPhase"]) {
  if (phase === "graph") return "proven";
  if (phase === "manifest") return "manifest-backed";
  if (phase === "duplication" || phase === "health") return "heuristic-high";
  return "heuristic-medium";
}

export function evidenceKindForPhase(phase: Diagnostic["analysisPhase"]) {
  if (phase === "file") return "ast";
  if (phase === "manifest") return "manifest";
  if (phase === "graph" || phase === "workspace") return "graph";
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
