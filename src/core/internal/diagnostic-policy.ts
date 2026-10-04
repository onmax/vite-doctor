import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import type { Diagnostic } from "../primitives.js";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";

export interface DiagnosticPolicyInput {
  root: string;
  config: DoctorConfig;
  options: DoctorRunOptions;
  diagnostics: Diagnostic[];
}

export interface DiagnosticPolicyResult {
  diagnostics: Diagnostic[];
  suppressedDiagnostics: Diagnostic[];
}

export function applyDiagnosticPolicy(input: DiagnosticPolicyInput): DiagnosticPolicyResult {
  const suppressed: Diagnostic[] = [];
  const sourceLines = new Map<string, string[]>();
  const baseline = readBaseline(input.root, input.options.baseline);
  const nextDiagnostics: Diagnostic[] = [];
  for (const diagnostic of input.diagnostics) {
    const suppression = findSuppression(input.root, input.config, diagnostic, sourceLines);
    const inBaseline = baseline.has(diagnostic.fingerprint ?? "");
    if (suppression || (input.options.newOnly && inBaseline)) {
      suppressed.push({
        ...diagnostic,
        suppressed: true,
        suppressionReason: suppression ?? (inBaseline ? "baseline" : undefined),
      });
      continue;
    }
    nextDiagnostics.push(diagnostic);
  }

  const diagnostics = dedupeDiagnostics(nextDiagnostics);
  const suppressedDiagnostics = dedupeDiagnostics(suppressed);
  if (input.options.updateBaseline && input.options.baseline)
    writeBaseline(input.root, input.options.baseline, [...diagnostics, ...suppressedDiagnostics]);

  return { diagnostics, suppressedDiagnostics };
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key =
      diagnostic.fingerprint ??
      `${diagnostic.ruleId}:${diagnostic.file}:${diagnostic.range?.start ?? ""}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readBaseline(root: string, baseline?: string): Set<string> {
  if (!baseline) return new Set();
  const file = resolve(root, baseline);
  const invalid = (reason: string) => doctorInternalDiagnostics.DOC0025({ file, reason });
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Set();
    throw invalid(`Cannot read the file${code ? ` (${code})` : ""}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw invalid("The file is not valid JSON.");
  }
  let entries: unknown[];
  if (Array.isArray(json)) entries = json;
  else if (json && typeof json === "object" && "diagnostics" in json) {
    if ("reportVersion" in json) {
      if (json.reportVersion !== 3) throw invalid("Expected Doctor JSON report version 3.");
    } else if ("version" in json && json.version !== 1)
      throw invalid("Expected baseline version 1.");
    if (!Array.isArray(json.diagnostics)) throw invalid('Expected a "diagnostics" array.');
    entries = json.diagnostics;
  } else throw invalid('Expected an array or an object containing a "diagnostics" array.');

  const fingerprints = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const fingerprint =
      entry && typeof entry === "object" && "fingerprint" in entry ? entry.fingerprint : entry;
    if (typeof fingerprint !== "string" || !fingerprint.length)
      throw invalid(`Entry ${index + 1} must contain a non-empty string fingerprint.`);
    fingerprints.add(fingerprint);
  }
  return fingerprints;
}

function writeBaseline(root: string, baseline: string, diagnostics: Diagnostic[]): void {
  const file = resolve(root, baseline);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: 1,
        diagnostics: diagnostics
          .map((diagnostic) => ({
            ruleId: diagnostic.ruleId,
            file: relative(root, diagnostic.file),
            fingerprint: diagnostic.fingerprint,
          }))
          .sort((a, b) =>
            `${a.ruleId}:${a.file}:${a.fingerprint}`.localeCompare(
              `${b.ruleId}:${b.file}:${b.fingerprint}`,
            ),
          ),
      },
      null,
      2,
    )}\n`,
  );
}

function findSuppression(
  root: string,
  config: DoctorConfig,
  diagnostic: Diagnostic,
  sourceLines: Map<string, string[]>,
): string | null {
  const configured = config.suppressions?.find((suppression) => {
    if (suppression.ruleId && suppression.ruleId !== diagnostic.ruleId) return false;
    if (suppression.fingerprint && suppression.fingerprint !== diagnostic.fingerprint) return false;
    if (suppression.file && !nativeMatch(relative(root, diagnostic.file), suppression.file))
      return false;
    return true;
  });
  if (configured) return configured.reason;
  let lines = sourceLines.get(diagnostic.file);
  if (!lines) {
    try {
      lines = readFileSync(diagnostic.file, "utf8").split(/\r?\n/);
    } catch {
      lines = [];
    }
    sourceLines.set(diagnostic.file, lines);
  }
  const line = diagnostic.range?.line;
  const start = line ? Math.max(0, line - 3) : 0;
  const end = line ? Math.min(lines.length, line + 1) : lines.length;
  for (let index = start; index < end; index++) {
    const inline = lines[index]!.match(
      /doctor-disable(-next-line)?\s+([^\s]+)(?:\s+--\s+(.+)|\s+(.+))?/,
    );
    if (!inline || (inline[1] && line !== index + 2)) continue;
    const rules = inline[2]!.split(",").map((item) => item.trim());
    if (!rules.includes(diagnostic.ruleId) && !rules.includes("*")) continue;
    const reason = (inline[3] ?? inline[4] ?? "").trim();
    return reason || "missing suppression reason";
  }
  return null;
}

function nativeMatch(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
