import { relative } from "pathe";
import type { DiagnosticEvidence, RuntimeFrameworkDiagnostic, SourceRange } from "../primitives.js";
import { pushDiagnostic, sourceTextFor } from "./diagnostics.js";
import { runtimeCallSiteKey } from "./runtime-call-site.js";
import type { ScanSession } from "./scan-session.js";
import { sha256 } from "./utils.js";

export const FRAMEWORK_DIAGNOSTICS_EVIDENCE = "frameworkDiagnostics";

/**
 * Reports each framework diagnostic a Plugin Surface collected at runtime. The framework already
 * decided the problem is real, so Doctor keeps its message and fix and adds only the location it
 * can prove from the dev server.
 */
export function reportRuntimeFrameworkDiagnostics(session: ScanSession): void {
  const evidence = session.project.runtimeEvidence?.[FRAMEWORK_DIAGNOSTICS_EVIDENCE];
  const reports = (evidence as { reports?: unknown } | undefined)?.reports;
  if (!Array.isArray(reports)) return;
  for (const report of reports.filter(isRuntimeFrameworkDiagnostic)) {
    const location = report.location;
    const file = location?.file ?? session.root;
    const range = location?.line ? rangeAt(sourceTextFor(session, file), location) : undefined;
    const gap =
      report.locationGap ??
      (location?.line && !range
        ? `The reported line ${location.line} is past the end of the file.`
        : undefined);
    const evidence: DiagnosticEvidence[] = [
      { kind: "runtime", summary: `Reported at runtime by the framework as ${report.code}.` },
      ...report.sources.map((source) => ({
        kind: "runtime" as const,
        summary: `Runtime call site: ${source}`,
      })),
      ...(report.docs
        ? [{ kind: "runtime" as const, summary: `Framework docs: ${report.docs}` }]
        : []),
      ...(gap ? [{ kind: "runtime" as const, summary: `Partial location: ${gap}` }] : []),
    ];
    pushDiagnostic(session, {
      ruleId: "doctor/runtime/framework-diagnostic",
      severity: "warn",
      category: "runtime",
      file,
      range,
      fingerprint: range
        ? undefined
        : sha256(
            JSON.stringify([
              "doctor/runtime/framework-diagnostic",
              relative(session.root, file),
              report.code,
              report.why,
              runtimeCallSiteKey(report.sources[0]),
            ]),
          ),
      sources: range ? [`${file}:${range.line}:${range.column}`] : undefined,
      why: `${report.code}: ${report.why}`,
      suggestion: suggestion(report),
      evidence,
      confidence: "runtime-backed",
    });
  }
}

// Any Doctor Extension can contribute this evidence, so Doctor reports only well-formed entries.
function isRuntimeFrameworkDiagnostic(value: unknown): value is RuntimeFrameworkDiagnostic {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<RuntimeFrameworkDiagnostic>;
  return (
    typeof report.code === "string" &&
    typeof report.why === "string" &&
    Array.isArray(report.sources) &&
    report.sources.every((source) => typeof source === "string") &&
    (report.location === undefined || typeof report.location.file === "string")
  );
}

function suggestion({ code, fix, docs }: RuntimeFrameworkDiagnostic): string {
  if (fix && docs) return `${fix} See ${docs}.`;
  if (fix) return fix;
  if (docs) return `The framework reported no fix for ${code}; follow ${docs}.`;
  return `The framework reported no fix for ${code}; read its message and the reported call site.`;
}

/** The identifier or token that starts at the reported position. */
function rangeAt(
  source: string | null,
  { line, column = 1 }: { line?: number; column?: number },
): SourceRange | undefined {
  if (source === null || !line) return undefined;
  let start = 0;
  for (let current = 1; current < line; current++) {
    const next = source.indexOf("\n", start);
    if (next === -1) return undefined;
    start = next + 1;
  }
  const lineEnd = source.indexOf("\n", start);
  const offset = start + column - 1;
  if (offset > (lineEnd === -1 ? source.length : lineEnd)) return undefined;
  const token = /^[\w$]+/.exec(source.slice(offset))?.[0] ?? "";
  return { start: offset, end: offset + Math.max(token.length, 1), line, column };
}
