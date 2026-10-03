import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import type { Diagnostic } from "../primitives.js";
import { parseScript } from "./script.js";

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

interface InlineSuppression {
  nextLine: boolean;
  rules: string[];
  reason: string;
}

export function applyDiagnosticPolicy(input: DiagnosticPolicyInput): DiagnosticPolicyResult {
  const suppressed: Diagnostic[] = [];
  const sourceLines = new Map<string, string[]>();
  const sourceSuppressions = new Map<string, Map<number, InlineSuppression>>();
  const baseline = readBaseline(input.root, input.options.baseline);
  const nextDiagnostics: Diagnostic[] = [];
  for (const diagnostic of input.diagnostics) {
    const suppression = findSuppression(
      input.root,
      input.config,
      diagnostic,
      sourceLines,
      sourceSuppressions,
    );
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
  sourceLines: Map<string, string[]>,
  sourceSuppressions: Map<string, Map<number, InlineSuppression>>,
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
  let directives = sourceSuppressions.get(diagnostic.file);
  if (!directives) {
    directives = collectInlineSuppressions(diagnostic.file, lines);
    sourceSuppressions.set(diagnostic.file, directives);
  }
  const line = diagnostic.range?.line;
  const start = line ? Math.max(0, line - 3) : 0;
  const end = line ? Math.min(lines.length, line + 1) : lines.length;
  for (let index = start; index < end; index++) {
    const inline = directives.get(index);
    if (!inline || (inline.nextLine && line !== index + 2)) continue;
    if (!inline.rules.includes(diagnostic.ruleId) && !inline.rules.includes("*")) continue;
    return inline.reason;
  }
  return null;
}

function collectInlineSuppressions(file: string, lines: string[]): Map<number, InlineSuppression> {
  const source = lines.join("\n");
  const parsed = parseScript(file, source);
  if (parsed && !source.includes("<!--")) {
    const directives = new Map<number, InlineSuppression>();
    for (const comment of (parsed.comments as Array<{ start?: number; value?: string }>) ?? []) {
      if (typeof comment.start !== "number" || typeof comment.value !== "string") continue;
      const line = source.slice(0, comment.start).split("\n").length - 1;
      addInlineSuppression(directives, line, comment.value);
    }
    return directives;
  }
  const directives = new Map<number, InlineSuppression>();
  let inBlockComment = false;
  let inHtmlComment = false;
  let quote: string | undefined;
  for (let line = 0; line < lines.length; line++) {
    const currentLine = lines[line]!;
    for (let offset = 0; offset < currentLine.length;) {
      if (inBlockComment) {
        const end = currentLine.indexOf("*/", offset);
        const commentEnd = end === -1 ? currentLine.length : end;
        addInlineSuppression(directives, line, currentLine.slice(offset, commentEnd));
        if (end === -1) break;
        inBlockComment = false;
        offset = end + 2;
        continue;
      }
      if (inHtmlComment) {
        const end = currentLine.indexOf("-->", offset);
        if (end === -1) {
          addInlineSuppression(directives, line, currentLine.slice(offset));
          break;
        }
        addInlineSuppression(directives, line, currentLine.slice(offset, end));
        inHtmlComment = false;
        offset = end + 3;
        continue;
      }
      if (currentLine.startsWith("//", offset)) {
        addInlineSuppression(directives, line, currentLine.slice(offset + 2));
        break;
      }
      if (currentLine.startsWith("/*", offset)) {
        inBlockComment = true;
        offset += 2;
        continue;
      }
      if (currentLine.startsWith("<!--", offset)) {
        addInlineSuppression(directives, line, currentLine.slice(offset + 4));
        inHtmlComment = !currentLine.slice(offset + 4).includes("-->");
        break;
      }
      const currentQuote = quote ?? currentLine[offset];
      if (currentQuote === "'" || currentQuote === '"' || currentQuote === "`") {
        const next = skipQuoted(currentLine, quote ? offset - 1 : offset, currentQuote);
        quote = next === currentLine.length ? currentQuote : undefined;
        offset = next;
        continue;
      }
      offset++;
    }
  }
  return directives;
}

function addInlineSuppression(
  directives: Map<number, InlineSuppression>,
  line: number,
  comment: string,
): void {
  if (directives.has(line)) return;
  const match = comment.match(
    /(?:^|\s)doctor-disable(-next-line)?\s+([^\s]+)(?:\s+--\s+(.+)|\s+(.+))?/,
  );
  if (!match) return;
  const rules = match[2]!.split(",").map((item) => item.trim());
  const reason = (match[3] ?? match[4] ?? "").trim() || "missing suppression reason";
  directives.set(line, { nextLine: Boolean(match[1]), rules, reason });
}

function skipQuoted(source: string, start: number, quote: string): number {
  for (let offset = start + 1; offset < source.length; offset++) {
    if (source[offset] === "\\") {
      offset++;
      continue;
    }
    if (source[offset] === quote) return offset + 1;
  }
  return source.length;
}

function nativeMatch(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
