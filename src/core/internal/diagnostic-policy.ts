import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import type { Diagnostic } from "../primitives.js";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import { lineColumnAt } from "./line-index.js";
import { parseScript } from "./script.js";
import { sha256 } from "./utils.js";

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

export interface BaselineWriteHooks {
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
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

  if (input.options.updateBaseline && input.options.baseline)
    writeBaseline(input.root, input.options.baseline, [...nextDiagnostics, ...suppressed]);

  return { diagnostics: nextDiagnostics, suppressedDiagnostics: suppressed };
}

// Duplicates are keyed by start offset because overlapping passes can report one finding with
// different end offsets, such as a call and its callee. The first occurrence keeps the anchor
// fingerprint so existing baselines and suppressions still match. This runs before scope and
// severity filters so occurrence indexes never depend on which Diagnostics a run reports.
export function settleDiagnosticIdentity(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique = diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.ruleId,
      diagnostic.code,
      diagnostic.file,
      diagnostic.range?.start ?? "",
      diagnostic.message,
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const groups = new Map<string, number[]>();
  for (const [index, diagnostic] of unique.entries()) {
    if (!diagnostic.fingerprint) continue;
    const group = groups.get(diagnostic.fingerprint);
    if (group) group.push(index);
    else groups.set(diagnostic.fingerprint, [index]);
  }
  for (const [fingerprint, group] of groups) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) => (unique[a]!.range?.start ?? -1) - (unique[b]!.range?.start ?? -1) || a - b,
    );
    for (const [occurrence, index] of group.entries()) {
      if (occurrence === 0) continue;
      unique[index] = { ...unique[index]!, fingerprint: sha256(`${fingerprint}:${occurrence}`) };
    }
  }
  return unique;
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
    const suppressedEntries =
      "suppressedDiagnostics" in json ? json.suppressedDiagnostics : undefined;
    if (suppressedEntries !== undefined && !Array.isArray(suppressedEntries))
      throw invalid('Expected a "suppressedDiagnostics" array.');
    entries = [...json.diagnostics, ...(suppressedEntries ?? [])];
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

export function writeBaseline(
  root: string,
  baseline: string,
  diagnostics: Diagnostic[],
  hooks: BaselineWriteHooks = {},
): void {
  const file = resolve(root, baseline);
  mkdirSync(dirname(file), { recursive: true });
  const target = baselineTarget(file);
  const text = `${JSON.stringify(
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
  )}\n`;
  const temporary = `${target.path}.vite-doctor-${process.pid}-${randomUUID()}.tmp`;
  const mode = target.mode === undefined ? undefined : target.mode & 0o7777;
  try {
    const write = hooks.writeFileSync ?? writeFileSync;
    if (mode === undefined) write(temporary, text);
    else {
      write(temporary, text, { mode });
      chmodSync(temporary, mode);
    }
    (hooks.renameSync ?? renameSync)(temporary, target.path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function baselineTarget(file: string): { path: string; mode?: number } {
  let target = file;
  const visited = new Set<string>();
  while (true) {
    let entry;
    try {
      entry = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: target };
      throw error;
    }
    if (!entry.isSymbolicLink()) return { path: target, mode: entry.mode };
    if (visited.has(target)) {
      const error = new Error(
        `Baseline path contains a symlink loop: ${file}`,
      ) as NodeJS.ErrnoException;
      error.code = "ELOOP";
      throw error;
    }
    visited.add(target);
    const link = readlinkSync(target);
    if (isAbsolute(link)) target = link;
    else target = resolve(realpathSync(dirname(target)), link);
  }
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
  if (!diagnostic.range) return null;
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
  const line = diagnostic.range.line;
  const start = Math.max(0, line - 3);
  const end = Math.min(lines.length, line + 1);
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
  let line = lineColumnAt(source, start).line - 1;
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
