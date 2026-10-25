import { relative } from "pathe";
import type { DoctorSeverity } from "./core/primitives.js";

/** A reported Diagnostic in a form that crosses a thread boundary and compares between runs. */
export interface SurfaceDiagnostic {
  /** The Diagnostic fingerprint, which survives edits that only move the Diagnostic. */
  id: string;
  severity: DoctorSeverity;
  /** Absolute paths of the Diagnostic file and its related locations. */
  files: string[];
  /** `CODE path:line:column message`, for a Diagnostic that was resolved. */
  summary: string;
  /** The Diagnostic as the text report renders it, for a new Diagnostic. */
  detail: string;
}

export interface SurfaceEvidenceGap {
  id: string;
  source: string;
  message: string;
  files: string[];
}

/** What the serve-mode Plugin Surface knows the project reports after its latest Doctor Run. */
export interface DiagnosticState {
  diagnostics: Map<string, SurfaceDiagnostic>;
  evidenceGaps: Map<string, SurfaceEvidenceGap>;
  runtimeIncomplete: boolean;
}

export interface SurfaceRunReport {
  diagnostics: SurfaceDiagnostic[];
  evidenceGaps: SurfaceEvidenceGap[];
  runtimeIncomplete: boolean;
}

export interface DiagnosticDelta {
  added: SurfaceDiagnostic[];
  resolved: SurfaceDiagnostic[];
  addedGaps: SurfaceEvidenceGap[];
  resolvedGaps: SurfaceEvidenceGap[];
  /** Set when the run became incomplete or complete for a reason other than evidence gaps. */
  runtimeIncomplete?: boolean;
}

export function stateFromRun(run: SurfaceRunReport): DiagnosticState {
  return {
    diagnostics: new Map(run.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])),
    evidenceGaps: new Map(run.evidenceGaps.map((gap) => [gap.id, gap])),
    runtimeIncomplete: run.runtimeIncomplete,
  };
}

/**
 * Replaces what `previous` knew about the affected files with an affected-files run. The run
 * reports every Diagnostic with a location in those files, so earlier ones that touch them and
 * are missing now were resolved. Diagnostics and evidence gaps elsewhere keep their previous
 * state until a run reports their files again.
 */
export function mergeAffectedRun(
  previous: DiagnosticState,
  affectedFiles: ReadonlySet<string>,
  run: SurfaceRunReport,
): DiagnosticState {
  const touches = (files: string[]) => files.some((file) => affectedFiles.has(file));
  const diagnostics = new Map(
    [...previous.diagnostics].filter(([, diagnostic]) => !touches(diagnostic.files)),
  );
  for (const diagnostic of run.diagnostics) diagnostics.set(diagnostic.id, diagnostic);
  const evidenceGaps = new Map([...previous.evidenceGaps].filter(([, gap]) => !touches(gap.files)));
  for (const gap of run.evidenceGaps) evidenceGaps.set(gap.id, gap);
  return { diagnostics, evidenceGaps, runtimeIncomplete: run.runtimeIncomplete };
}

export function diffStates(previous: DiagnosticState, next: DiagnosticState): DiagnosticDelta {
  const missingFrom = <T extends { id: string }>(items: Map<string, T>, other: Map<string, T>) =>
    [...items.values()].filter((item) => !other.has(item.id));
  return {
    added: missingFrom(next.diagnostics, previous.diagnostics),
    resolved: missingFrom(previous.diagnostics, next.diagnostics),
    addedGaps: missingFrom(next.evidenceGaps, previous.evidenceGaps),
    resolvedGaps: missingFrom(previous.evidenceGaps, next.evidenceGaps),
    runtimeIncomplete:
      previous.runtimeIncomplete === next.runtimeIncomplete ? undefined : next.runtimeIncomplete,
  };
}

export interface DeltaLog {
  level: "error" | "warn" | "info";
  message: string;
}

export interface DeltaLogOptions {
  root: string;
  /** Files whose change started the run, for the log header. */
  changed: readonly string[];
  mode: "warn" | "error";
  maxWarnings?: number;
}

/**
 * Renders what changed since the previous Doctor Run, or nothing when nothing did. The totals
 * line describes the whole known state, so an agent can tell whether the project still fails.
 */
export function formatDelta(
  delta: DiagnosticDelta,
  next: DiagnosticState,
  options: DeltaLogOptions,
): DeltaLog | undefined {
  const { added, resolved, addedGaps, resolvedGaps } = delta;
  if (
    !added.length &&
    !resolved.length &&
    !addedGaps.length &&
    !resolvedGaps.length &&
    delta.runtimeIncomplete === undefined
  )
    return undefined;

  const totals = { blocker: 0, error: 0, warn: 0, info: 0 };
  for (const diagnostic of next.diagnostics.values()) totals[diagnostic.severity]++;
  const incomplete = next.evidenceGaps.size > 0 || next.runtimeIncomplete;
  const warningsFail = options.maxWarnings !== undefined && totals.warn > options.maxWarnings;
  const fails = incomplete || totals.blocker > 0 || totals.error > 0 || warningsFail;
  const addedFailure =
    addedGaps.length > 0 ||
    delta.runtimeIncomplete === true ||
    added.some(
      ({ severity }) =>
        severity === "blocker" || severity === "error" || (severity === "warn" && warningsFail),
    );

  const counts = [
    added.length && `${added.length} new ${plural(added.length, "Diagnostic")}`,
    resolved.length && `${resolved.length} resolved`,
  ].filter(Boolean);
  const lines = [
    `Vite Doctor: ${counts.length ? counts.join(", ") : "evidence changed"} after changes to ${changedFiles(options)}`,
  ];
  for (const gap of addedGaps)
    lines.push(`Evidence missing: ${gap.message} ${relativeFiles(options.root, gap.files)}`);
  if (delta.runtimeIncomplete === true)
    lines.push("Runtime Evidence missing: a required framework runtime is unresolved");
  for (const severity of ["blocker", "error", "warn", "info"] as const)
    for (const diagnostic of added)
      if (diagnostic.severity === severity) lines.push(diagnostic.detail);
  for (const diagnostic of resolved) lines.push(`  resolved: ${diagnostic.summary}`);
  for (const gap of resolvedGaps)
    lines.push(`Evidence restored: ${gap.message} ${relativeFiles(options.root, gap.files)}`);
  if (delta.runtimeIncomplete === false) lines.push("Runtime Evidence restored");
  lines.push(
    `Now: ${totals.blocker} ${plural(totals.blocker, "blocker")}, ${totals.error} ${plural(totals.error, "error")}, ${totals.warn} ${plural(totals.warn, "warning")}, ${totals.info} info${incomplete ? ", status incomplete" : ""}`,
  );

  const level =
    options.mode === "error" && fails && addedFailure
      ? "error"
      : addedGaps.length || added.some(({ severity }) => severity !== "info")
        ? "warn"
        : "info";
  return { level, message: lines.join("\n") };
}

function changedFiles({ root, changed }: DeltaLogOptions): string {
  const shown = changed.slice(0, 3).map((file) => relative(root, file) || ".");
  return changed.length > shown.length
    ? `${shown.join(", ")} and ${changed.length - shown.length} more`
    : shown.join(", ");
}

function relativeFiles(root: string, files: string[]): string {
  return files.map((file) => relative(root, file) || file).join(", ");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
