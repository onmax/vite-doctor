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
import { dirname, isAbsolute, relative, resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import type { Diagnostic } from "../primitives.js";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import { lineColumnAt } from "./line-index.js";
import { loadVueCompilerSfc } from "./lazy-parsers.js";
import { walkAstFacts } from "./facts.js";
import { parseScript } from "./script.js";
import { parseVueScriptsResult } from "./sfc.js";
import {
  SFC_TEMPLATE_PARSE_OPTIONS,
  TemplateNodeType,
  templateAstFromDescriptor,
  walkTemplate,
} from "./template.js";
import { sha256 } from "./utils.js";
import { viteDoctorVersion } from "../../version.js";
import { FINGERPRINT_SCHEME } from "../diagnostic-constants.js";

export interface DiagnosticPolicyInput {
  root: string;
  config: DoctorConfig;
  options: DoctorRunOptions;
  diagnostics: Diagnostic[];
}

export interface DiagnosticPolicyResult {
  diagnostics: Diagnostic[];
  suppressedDiagnostics: Diagnostic[];
  /** Set when `newOnly` filters through a baseline written with another fingerprint scheme. */
  staleBaseline?: StaleBaseline;
}

export interface StaleBaseline {
  file: string;
  fingerprintScheme?: number;
  doctorVersion?: string;
}

interface Baseline extends StaleBaseline {
  fingerprints: Set<string>;
}

export interface BaselineWriteHooks {
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
}

export interface InlineSuppression {
  /** Zero-based line of the directive. */
  line: number;
  nextLine: boolean;
  rules: InlineSuppressionRule[];
  reason: string;
  /** Source offsets of the directive, from `doctor-disable` through its reason. */
  start: number;
  end: number;
  /** Source offsets of the comma-separated Rule list. */
  list: { start: number; end: number };
  /** Source offsets of the written reason, when there is one. */
  reasonRange?: { start: number; end: number };
  /** A comment or line edit when the directive has no surrounding prose. */
  removal?: { range: SourceComment; text: string; embeddedMarkup?: boolean };
  shadowing?: boolean;
}

export interface InlineSuppressionRule {
  id: string;
  start: number;
  end: number;
}

interface InlineSuppressions {
  all: InlineSuppression[];
  lineCount: number;
  nearby: Map<number, InlineSuppression>;
  byTargetLine: Map<number, InlineSuppression[]>;
}

/** Reads and indexes inline `doctor-disable` directives once per file. */
export class InlineSuppressionIndex {
  private files = new Map<string, InlineSuppressions>();

  constructor(private readText: (file: string) => string | null | undefined = () => undefined) {}

  directives(file: string): InlineSuppression[] {
    return this.load(file).all;
  }

  /** Every directive that names the Diagnostic's Rule (or `*`) and covers its line, first match first. */
  matching(diagnostic: Diagnostic): InlineSuppression[] {
    if (!diagnostic.range) return [];
    const directives = this.load(diagnostic.file);
    if (!directives.all.length) return [];
    const line = diagnostic.range.line;
    const applies = (inline: InlineSuppression) =>
      inline.rules.some((rule) => rule.id === diagnostic.ruleId || rule.id === "*");
    const matches: InlineSuppression[] = [];
    const start = Math.max(0, line - 3);
    const end = Math.min(directives.lineCount, line + 1);
    for (let index = start; index < end; index++) {
      const inline = directives.nearby.get(index);
      if (inline && applies(inline)) matches.push(inline);
    }
    for (const inline of directives.byTargetLine.get(line - 1) ?? [])
      if (applies(inline)) matches.push(inline);
    return matches;
  }

  private load(file: string): InlineSuppressions {
    let directives = this.files.get(file);
    if (directives) return directives;
    let text = this.readText(file);
    if (typeof text !== "string") {
      try {
        text = readFileSync(file, "utf8");
      } catch {
        text = "";
      }
    }
    directives = collectInlineSuppressions(file, text);
    this.files.set(file, directives);
    return directives;
  }
}

export function applyDiagnosticPolicy(input: DiagnosticPolicyInput): DiagnosticPolicyResult {
  const suppressed: Diagnostic[] = [];
  const inline = new InlineSuppressionIndex();
  const baseline = readBaseline(input.root, input.options.baseline);
  const fingerprints = baseline?.fingerprints ?? new Set<string>();
  const nextDiagnostics: Diagnostic[] = [];
  for (const diagnostic of input.diagnostics) {
    const suppression = findSuppression(input.root, input.config, diagnostic, inline);
    const inBaseline = fingerprints.has(diagnostic.fingerprint ?? "");
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

  const stale =
    baseline &&
    input.options.newOnly &&
    !input.options.updateBaseline &&
    baseline.fingerprints.size > 0 &&
    baseline.fingerprintScheme !== FINGERPRINT_SCHEME;
  return {
    diagnostics: nextDiagnostics,
    suppressedDiagnostics: suppressed,
    staleBaseline: stale
      ? {
          file: baseline.file,
          fingerprintScheme: baseline.fingerprintScheme,
          doctorVersion: baseline.doctorVersion,
        }
      : undefined,
  };
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

function readBaseline(root: string, baseline?: string): Baseline | undefined {
  if (!baseline) return undefined;
  const file = resolve(root, baseline);
  const invalid = (reason: string) => doctorInternalDiagnostics.DOC0025({ file, reason });
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw invalid(`Cannot read the file${code ? ` (${code})` : ""}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw invalid("The file is not valid JSON.");
  }
  let entries: unknown[];
  let fingerprintScheme: number | undefined;
  let doctorVersion: string | undefined;
  if (Array.isArray(json)) entries = json;
  else if (json && typeof json === "object" && "diagnostics" in json) {
    const scheme = "fingerprintScheme" in json ? json.fingerprintScheme : undefined;
    if (scheme !== undefined && typeof scheme !== "number")
      throw invalid('Expected "fingerprintScheme" to be a number.');
    fingerprintScheme = scheme;
    if ("reportVersion" in json) {
      if (json.reportVersion !== 3 && json.reportVersion !== 4)
        throw invalid("Expected Doctor JSON report version 3 or 4.");
      if ("version" in json && typeof json.version === "string") doctorVersion = json.version;
    } else if ("version" in json && json.version === 2) {
      if (scheme === undefined) throw invalid('Baseline version 2 requires "fingerprintScheme".');
      if ("doctorVersion" in json && typeof json.doctorVersion === "string")
        doctorVersion = json.doctorVersion;
    } else if ("version" in json && json.version !== 1)
      throw invalid("Expected baseline version 1 or 2.");
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
  return { file, fingerprints, fingerprintScheme, doctorVersion };
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
      version: 2,
      fingerprintScheme: FINGERPRINT_SCHEME,
      doctorVersion: viteDoctorVersion,
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

type ConfigSuppression = NonNullable<DoctorConfig["suppressions"]>[number];

export function unusedConfigSuppressions(
  root: string,
  config: DoctorConfig,
  diagnostics: Diagnostic[],
): ConfigSuppression[] {
  return unusedConfigSuppressionEntries(root, config, diagnostics).map(
    (entry) => entry.suppression,
  );
}

export function unusedConfigSuppressionEntries(
  root: string,
  config: DoctorConfig,
  diagnostics: Diagnostic[],
): Array<{ suppression: ConfigSuppression; index: number }> {
  return (config.suppressions ?? [])
    .map((suppression, index) => ({ suppression, index }))
    .filter(
      ({ suppression }) =>
        !diagnostics.some((diagnostic) => matchesConfigSuppression(root, suppression, diagnostic)),
    );
}

export function matchesSuppressionFile(relativePath: string, pattern: string): boolean {
  return nativeMatch(relativePath, pattern);
}

function matchesConfigSuppression(
  root: string,
  suppression: ConfigSuppression,
  diagnostic: Diagnostic,
): boolean {
  if (suppression.ruleId && suppression.ruleId !== diagnostic.ruleId) return false;
  // Broad entries must not hide the warning that reports them as unused.
  if (
    !suppression.ruleId &&
    (diagnostic.ruleId === "doctor/config/unused-suppression" ||
      diagnostic.ruleId.startsWith("doctor/inline/"))
  )
    return false;
  if (suppression.fingerprint && suppression.fingerprint !== diagnostic.fingerprint) return false;
  if (suppression.file && !nativeMatch(relative(root, diagnostic.file), suppression.file))
    return false;
  return true;
}

function findSuppression(
  root: string,
  config: DoctorConfig,
  diagnostic: Diagnostic,
  inline: InlineSuppressionIndex,
): string | null {
  const configured = config.suppressions?.find((suppression) =>
    matchesConfigSuppression(root, suppression, diagnostic),
  );
  if (configured) return configured.reason;
  // A `doctor-disable *` must not hide the report that its own directive is stale.
  if (diagnostic.ruleId.startsWith("doctor/inline/")) return null;
  return inline.matching(diagnostic)[0]?.reason ?? null;
}

function collectInlineSuppressions(file: string, source: string): InlineSuppressions {
  const lineCount = source.split("\n").length;
  const suppressions: InlineSuppressions = {
    all: [],
    lineCount,
    nearby: new Map(),
    byTargetLine: new Map(),
  };
  if (!source.includes("doctor-disable")) return suppressions;
  const directives = new Map<number, InlineSuppression>();
  const { comments, codeFree } = file.endsWith(".vue")
    ? collectVueComments(file, source)
    : collectScriptComments(file, source);
  for (const comment of comments) {
    addCommentSuppressions(directives, source, comment, codeFree);
  }
  const code = linesWithCode(source, [...comments, ...codeFree]);
  suppressions.all = [...directives.values()].sort((a, b) => a.start - b.start);
  for (const [line, directive] of directives) {
    if (!directive.nextLine) {
      suppressions.nearby.set(line, directive);
      continue;
    }
    // Comments such as SAFETY notes often sit between a directive and the code it covers.
    let target = line + 1;
    while (target < code.length && !code[target]) target++;
    const targeted = suppressions.byTargetLine.get(target);
    if (targeted) targeted.push(directive);
    else suppressions.byTargetLine.set(target, [directive]);
  }
  return suppressions;
}

function linesWithCode(source: string, spans: SourceComment[]): boolean[] {
  const masked = source.split("");
  for (const span of spans) {
    for (let index = span.start; index < span.end; index++) {
      if (masked[index] !== "\n") masked[index] = " ";
    }
  }
  return masked
    .join("")
    .split("\n")
    .map((line) => line.trim().length > 0);
}

interface SourceComment {
  start: number;
  end: number;
}

function collectScriptComments(
  file: string,
  source: string,
): { comments: SourceComment[]; codeFree: SourceComment[] } {
  const parsed = parseScript(file, source);
  if (!parsed) return { comments: [], codeFree: [] };
  const comments = ((parsed.comments as Array<{ start?: number; end?: number }>) ?? []).filter(
    (comment): comment is { start: number; end: number } =>
      typeof comment.start === "number" && typeof comment.end === "number",
  );
  return { comments, codeFree: /\.[cm]?[jt]sx$/.test(file) ? jsxCommentContainers(parsed) : [] };
}

// A JSX comment's `{}` container holds no code, but it sits outside the parsed comment span.
function jsxCommentContainers(ast: unknown): SourceComment[] {
  const containers: SourceComment[] = [];
  walkAstFacts(ast, (node) => {
    const container = node as { type?: string; expression?: { type?: string } } & SourceComment;
    if (
      container.type === "JSXExpressionContainer" &&
      container.expression?.type === "JSXEmptyExpression"
    )
      containers.push({ start: container.start, end: container.end });
  });
  return containers;
}

function collectVueComments(
  file: string,
  source: string,
): { comments: SourceComment[]; codeFree: SourceComment[] } {
  try {
    const { descriptor } = loadVueCompilerSfc().parse(source, {
      filename: file,
      sourceMap: false,
      templateParseOptions: SFC_TEMPLATE_PARSE_OPTIONS,
    });
    const script = parseVueScriptsResult(file, descriptor, source).ast;
    const comments: SourceComment[] = [
      ...((script?.comments as SourceComment[] | undefined) ?? []),
    ];
    const template = templateAstFromDescriptor(descriptor);
    if (template)
      walkTemplate(template, (node) => {
        if (node.type === TemplateNodeType.COMMENT)
          comments.push({ start: node.loc.start.offset, end: node.loc.end.offset });
      });
    return { comments, codeFree: script ? jsxCommentContainers(script) : [] };
  } catch {
    return { comments: [], codeFree: [] };
  }
}

function addCommentSuppressions(
  directives: Map<number, InlineSuppression>,
  source: string,
  comment: SourceComment,
  codeFree: SourceComment[],
): void {
  const { start, end } = comment;
  const rawComment = source.slice(start, end);
  const html = rawComment.startsWith("<!--");
  const block = rawComment.startsWith("/*");
  const opening = html ? 4 : block || rawComment.startsWith("//") ? 2 : 0;
  const closing =
    html && rawComment.endsWith("-->") ? 3 : block && rawComment.endsWith("*/") ? 2 : 0;
  const body = { start: start + opening, end: end - closing };
  let line = lineColumnAt(source, start).line - 1;
  let segmentStart = body.start;
  const added: InlineSuppression[] = [];
  for (const segment of source.slice(body.start, body.end).split("\n")) {
    const directive = addInlineSuppression(directives, line, segment, segmentStart, source);
    if (directive) added.push(directive);
    segmentStart += segment.length + 1;
    line++;
  }
  const container = block
    ? codeFree.find(
        (span) =>
          span.start < start &&
          end < span.end &&
          !source.slice(span.start + 1, start).trim() &&
          !source.slice(end, span.end - 1).trim(),
      )
    : undefined;
  for (const directive of added)
    directive.removal = directiveRemoval(
      source,
      comment,
      body,
      directive,
      added.length,
      container,
      html,
    );
}

function addInlineSuppression(
  directives: Map<number, InlineSuppression>,
  line: number,
  segment: string,
  offset: number,
  source: string,
): InlineSuppression | undefined {
  const match = segment.match(
    /(?:^|\s)doctor-disable(-next-line)?\s+([^\s]+)(?:\s+--\s+(.+)|\s+(.+))?/,
  );
  if (!match) return undefined;
  const first = directives.get(line);
  if (first) {
    first.shadowing = true;
    return undefined;
  }
  const start = offset + match.index! + match[0].indexOf("doctor-disable");
  const keyword = "doctor-disable".length + (match[1]?.length ?? 0);
  const listStart = source.indexOf(match[2]!, start + keyword);
  const rules: InlineSuppressionRule[] = [];
  let ruleStart = listStart;
  for (const item of match[2]!.split(",")) {
    const id = item.trim();
    if (id) rules.push({ id, start: ruleStart, end: ruleStart + item.length });
    ruleStart += item.length + 1;
  }
  const written = match[3] ?? match[4];
  const reason = written?.trim() || "missing suppression reason";
  const end = offset + match.index! + match[0].length;
  const directive: InlineSuppression = {
    line,
    nextLine: Boolean(match[1]),
    rules,
    reason,
    start,
    end,
    list: { start: listStart, end: listStart + match[2]!.length },
    reasonRange: written?.trim() ? { start: end - written.length, end } : undefined,
  };
  directives.set(line, directive);
  return directive;
}

function directiveRemoval(
  source: string,
  comment: SourceComment,
  body: SourceComment,
  directive: InlineSuppression,
  directivesInComment: number,
  container: SourceComment | undefined,
  html: boolean,
): InlineSuppression["removal"] {
  const blank = (text: string) => /^[\s*]*$/.test(text);
  if (
    directivesInComment === 1 &&
    blank(source.slice(body.start, directive.start)) &&
    blank(source.slice(directive.end, body.end))
  ) {
    const { start, end } = container ?? comment;
    const first = lineStart(source, start);
    const last = lineEnd(source, end);
    const before = source.slice(first, start);
    const after = source.slice(end, last);
    if (!before.trim() && !after.trim())
      return { range: { start: first, end: Math.min(source.length, last + 1) }, text: "" };
    if (container || html) return { range: { start, end }, text: "", embeddedMarkup: true };
    if (source.startsWith("//", start) && !after.trim())
      return { range: { start: start - (/[ \t]*$/.exec(before)?.[0].length ?? 0), end }, text: "" };
    return {
      range: { start, end },
      text: source.slice(start, end).replace(/[^\r\n\u2028\u2029]+/g, " "),
    };
  }
  // The directive shares its comment with other text, so only its own line can go.
  const start = lineStart(source, directive.start);
  const end = lineEnd(source, directive.start);
  if (blank(source.slice(start, directive.start)) && blank(source.slice(directive.end, end)))
    return { range: { start, end: Math.min(source.length, end + 1) }, text: "" };
  return undefined;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(source: string, offset: number): number {
  const end = source.indexOf("\n", offset);
  return end < 0 ? source.length : end;
}

function nativeMatch(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
