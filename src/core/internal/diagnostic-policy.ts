import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import type { Diagnostic } from "../primitives.js";

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
  const baseline = readBaseline(input.root, input.options.baseline);
  const nextDiagnostics: Diagnostic[] = [];
  for (const diagnostic of input.diagnostics) {
    const suppression = findSuppression(input.root, input.config, diagnostic);
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
  try {
    const json = JSON.parse(readFileSync(resolve(root, baseline), "utf8"));
    const entries = Array.isArray(json?.diagnostics)
      ? json.diagnostics
      : Array.isArray(json)
        ? json
        : [];
    return new Set(entries.map((entry: any) => entry.fingerprint ?? entry).filter(Boolean));
  } catch {
    return new Set();
  }
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
): string | null {
  const configured = config.suppressions?.find((suppression) => {
    if (suppression.ruleId && suppression.ruleId !== diagnostic.ruleId) return false;
    if (suppression.fingerprint && suppression.fingerprint !== diagnostic.fingerprint) return false;
    if (suppression.file && !nativeMatch(relative(root, diagnostic.file), suppression.file))
      return false;
    return true;
  });
  if (configured) return configured.reason;
  const text = readFileSync(diagnostic.file, "utf8");
  const line = diagnostic.range?.line;
  const lines = text.split(/\r?\n/);
  const nearby = line ? lines.slice(Math.max(0, line - 3), line + 1).join("\n") : text;
  const inline = nearby.match(/doctor-disable(?:-next-line)?\s+([^\s]+)(?:\s+--\s+(.+)|\s+(.+))?/);
  if (!inline) return null;
  const rules = inline[1].split(",").map((item) => item.trim());
  if (!rules.includes(diagnostic.ruleId) && !rules.includes("*")) return null;
  const reason = (inline[2] ?? inline[3] ?? "").trim();
  return reason || "missing suppression reason";
}

function nativeMatch(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
