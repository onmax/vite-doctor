import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import type { Diagnostic } from "../primitives.js";
import { parseScript } from "./script.js";

const require = createRequire(import.meta.url);

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
  if (!source.includes("doctor-disable")) return new Map();
  const directives = new Map<number, InlineSuppression>();
  const comments = file.endsWith(".vue")
    ? collectVueComments(source)
    : collectScriptComments(file, source);
  for (const comment of comments) {
    addCommentSuppressions(directives, source, comment.start, comment.end);
  }
  return directives;
}

interface SourceComment {
  start: number;
  end: number;
}

function collectScriptComments(file: string, source: string): SourceComment[] {
  const parsed = parseScript(file, source);
  if (!parsed) return [];
  return ((parsed.comments as Array<{ start?: number; end?: number }>) ?? []).filter(
    (comment): comment is { start: number; end: number } =>
      typeof comment.start === "number" && typeof comment.end === "number",
  );
}

function collectVueComments(source: string): SourceComment[] {
  try {
    const vueParser = require("vue-eslint-parser") as {
      parseForESLint: (
        text: string,
        options: Record<string, unknown>,
      ) => {
        ast: {
          comments?: Array<{ range?: [number, number] }>;
          templateBody?: { comments?: Array<{ range?: [number, number] }> };
        };
      };
    };
    const tsParser = require("@typescript-eslint/parser") as { parseForESLint: unknown };
    const { parse } = require("@vue/compiler-sfc") as typeof import("@vue/compiler-sfc");
    const { descriptor } = parse(source, { sourceMap: false });
    const jsx = [descriptor.script, descriptor.scriptSetup].some((block) =>
      ["tsx", "jsx"].includes(block?.lang?.toLowerCase() ?? ""),
    );
    const parsed = vueParser.parseForESLint(source, {
      comment: true,
      ecmaFeatures: { jsx },
      ecmaVersion: "latest",
      loc: true,
      parser: tsParser,
      range: true,
      sourceType: "module",
      tokens: true,
    });
    const comments = [...(parsed.ast.comments ?? []), ...(parsed.ast.templateBody?.comments ?? [])];
    return comments.flatMap((comment) => {
      const range = comment.range;
      return range ? [{ start: range[0], end: range[1] }] : [];
    });
  } catch {
    return [];
  }
}

function addCommentSuppressions(
  directives: Map<number, InlineSuppression>,
  source: string,
  start: number,
  end: number,
): void {
  const rawComment = source.slice(start, end);
  const comment = rawComment.startsWith("<!--")
    ? rawComment.slice(4, rawComment.endsWith("-->") ? -3 : undefined)
    : rawComment.startsWith("/*")
      ? rawComment.slice(2, rawComment.endsWith("*/") ? -2 : undefined)
      : rawComment.startsWith("//")
        ? rawComment.slice(2)
        : rawComment;
  let line = source.slice(0, start).split("\n").length - 1;
  for (const segment of comment.split("\n")) {
    addInlineSuppression(directives, line, segment);
    line++;
  }
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

function nativeMatch(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
