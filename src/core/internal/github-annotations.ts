import { readFileSync } from "node:fs";
import { relative } from "pathe";
import { detectProvider } from "std-env";
import type { Diagnostic, DoctorReportFormat, DoctorRunResult } from "../primitives.js";
import type { ReportReader } from "./agent-runtime.js";
import { lineColumnAt } from "./line-index.js";
import { reportOrder } from "./report-order.js";

// GitHub shows at most 10 annotations of each kind per step.
const ANNOTATIONS_PER_KIND = 10;

const COMMANDS = { blocker: "error", error: "error", warn: "warning" } as const;

/**
 * GitHub Actions workflow commands that annotate the PR diff with the errors and warnings of a
 * text report read in CI. Empty anywhere else.
 */
export function githubAnnotations(
  result: DoctorRunResult,
  format: DoctorReportFormat,
  reader: ReportReader | undefined,
  cwd: string,
): string {
  // The Doctor process swaps the environment per run, so read it at call time.
  if (reader !== "ci" || format !== "text" || detectProvider().name !== "github_actions") return "";
  const workspace = process.env.GITHUB_WORKSPACE || cwd;
  const counts = { error: 0, warning: 0 };
  const lines: string[] = [];
  for (const diagnostic of reportOrder(result.diagnostics).flat()) {
    if (diagnostic.severity === "info") continue;
    const command = COMMANDS[diagnostic.severity];
    if (counts[command] === ANNOTATIONS_PER_KIND) continue;
    const located = Boolean(diagnostic.range) || relative(result.root, diagnostic.file) !== "";
    if (!located && diagnostic.subject) continue;
    counts[command]++;
    lines.push(
      annotation(command, diagnostic, located ? relative(workspace, diagnostic.file) : ""),
    );
  }
  return lines.map((line) => `${line}\n`).join("");
}

function annotation(command: string, diagnostic: Diagnostic, file: string): string {
  const properties: Array<[string, string | number]> = [["title", diagnostic.code]];
  if (file) properties.push(["file", file]);
  if (diagnostic.range) {
    const { line, column } = diagnostic.range;
    properties.push(["line", line]);
    const end = rangeEnd(diagnostic);
    if (!end || end.line === line) properties.push(["col", column]);
    if (end) {
      properties.push(["endLine", end.line]);
      if (end.line === line) properties.push(["endColumn", end.column]);
    }
  }
  const message = diagnostic.brief ?? diagnostic.message;
  return `::${command} ${properties
    .map(([name, value]) => `${name}=${escapeProperty(String(value))}`)
    .join(",")}::${escapeData(diagnostic.docs ? `${message}\n${diagnostic.docs}` : message)}`;
}

function rangeEnd(diagnostic: Diagnostic): { line: number; column: number } | undefined {
  const range = diagnostic.range!;
  if (range.end <= range.start) return undefined;
  let source: string;
  try {
    source = readFileSync(diagnostic.file, "utf8");
  } catch {
    return undefined;
  }
  // The end is only an offset; trust it only when the start offset lands on the reported start.
  const start = lineColumnAt(source, range.start);
  if (start.line !== range.line || start.column !== range.column) return undefined;
  const end = lineColumnAt(source, range.end);
  return end.column === 1 ? lineColumnAt(source, range.end - 1) : end;
}

function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
