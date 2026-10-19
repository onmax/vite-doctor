import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "pathe";
import MagicString from "magic-string";
import type { DoctorConfig } from "../config.js";
import type {
  Diagnostic,
  DoctorRunResult,
  DoctorSeverity,
  FixEdit,
  ProjectInfo,
} from "../primitives.js";
import type { GraphSummary } from "./cache-store.js";
import { FINGERPRINT_SCHEME } from "../diagnostic-constants.js";
import {
  applyDiagnosticPolicy,
  settleDiagnosticIdentity,
  matchesSuppressionFile,
  unusedConfigSuppressionEntries,
  type StaleBaseline,
} from "./diagnostic-policy.js";
import { lineColumnAt } from "./line-index.js";
import { workspaceNuxtRoots, workspaceProjectView } from "./workspace-nuxt.js";
import { owningWorkspacePackage } from "./workspace-packages.js";
import { markSession, type ScanSession } from "./scan-session.js";
import { scoreDiagnostics } from "./scoring.js";
import { VERSION, sha256, shellArgument } from "./utils.js";
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
    root: session.root,
    includeUnsafe: session.options.unsafeFix,
    includeStructuralReview: session.options.structuralReview,
  });
  markSession(session, "fix", started);
  return applied;
}

export function applyPolicyFilters(session: ScanSession): void {
  session.diagnostics = settleDiagnosticIdentity(session.diagnostics);
  reportUnusedConfigSuppressions(session);
  applyReportEligibility(session);
  applySeverityFilter(session);
  const result = applyDiagnosticPolicy(session);
  session.diagnostics = result.diagnostics;
  session.suppressedDiagnostics = result.suppressedDiagnostics;
  if (result.staleBaseline) reportStaleBaseline(session, result.staleBaseline);
}

// The baseline is not a source file, so this skips scope filtering but still honors the
// severity threshold and the same suppression policy as every other Diagnostic.
function reportStaleBaseline(session: ScanSession, baseline: StaleBaseline): void {
  if (session.options.severity === "error") return;
  const path = relative(session.root, baseline.file) || baseline.file;
  const writer =
    baseline.fingerprintScheme === undefined
      ? "does not record the fingerprint scheme it was written with"
      : `was written with fingerprint scheme ${baseline.fingerprintScheme}`;
  const warning = normalizeDiagnosticFromRuleCode({
    ruleId: "doctor/baseline/stale-fingerprint-scheme",
    severity: "warn",
    category: "baseline",
    file: baseline.file,
    why: `Baseline "${path}"${baseline.doctorVersion ? ` (Doctor ${baseline.doctorVersion})` : ""} ${writer}, but this Doctor uses fingerprint scheme ${FINGERPRINT_SCHEME}. Recorded findings whose fingerprints changed are reported as new by --new-only.`,
    suggestion: `Regenerate the baseline with a full Doctor Run, without --changed, --since, or --rules: vite-doctor . --baseline ${shellArgument(path)} --update-baseline. Then commit the updated baseline.`,
    confidence: "proven",
    analysisPhase: "manifest",
  });
  warning.fingerprint ??= createDiagnosticFingerprint(
    session.root,
    warning,
    sourceTextFor(session, warning.file),
  );
  const result = applyDiagnosticPolicy({
    root: session.root,
    config: session.config,
    options: { ...session.options, updateBaseline: false },
    diagnostics: [warning],
  });
  session.diagnostics.push(...result.diagnostics);
  session.suppressedDiagnostics.push(...result.suppressedDiagnostics);
}

// Scoped runs skip Rules or files, so a suppression can match nothing without being stale.
function reportUnusedConfigSuppressions(session: ScanSession): void {
  const { options, root } = session;
  if (options.changed || options.since || options.rules || options.analyses) return;
  const ran = new Set(session.enabledRules.map((rule) => rule.meta.id));
  const effectiveExtends = options.extends ?? session.config.extends;
  // An entry without a Rule may belong to a Rule turned off in config, which cannot prove it stale.
  const unscoped =
    (effectiveExtends === undefined ||
      effectiveExtends === "auto" ||
      (Array.isArray(effectiveExtends) && effectiveExtends.includes("auto"))) &&
    !Object.values(session.config.rules ?? {}).includes("off");
  const analyzed = session.files.map((file) => relative(root, file.path));
  const unproven = new Set(
    (session.project.evidenceGaps ?? []).flatMap((gap) =>
      gap.files.map((file) => relative(root, resolve(root, file))),
    ),
  );
  const workspacePackages = session.project.workspacePackages ?? [];
  const workspaceRoots = new Set(workspacePackages.map((item) => item.root));
  const coversWorkspace = (scope: ReadonlySet<string> | undefined): boolean =>
    !scope || [...workspaceRoots].every((root) => scope.has(root));
  const unused = unusedConfigSuppressionEntries(root, session.config, session.diagnostics).filter(
    ({ suppression }) => {
      if (suppression.ruleId ? !ran.has(suppression.ruleId) : !unscoped) return false;
      const scope = suppression.ruleId ? session.ruleScopes.get(suppression.ruleId) : undefined;
      // A broad suppression is inconclusive when its Rule only ran in part of the workspace.
      if (!suppression.file && !coversWorkspace(scope)) return false;
      const pattern = suppression.file;
      if (!pattern) return unproven.size === 0;
      let targets = analyzed.filter((file) => matchesSuppressionFile(file, pattern));
      // Only a literal path that no longer exists is provably stale; any other unanalyzed
      // target may be excluded, ignored, or outside the source inventory.
      if (!targets.length) {
        if (pattern.includes("*") || existsSync(resolve(root, pattern))) return false;
        targets = [relative(root, resolve(root, pattern))];
      }
      if (targets.some((file) => unproven.has(file))) return false;
      return (
        !scope ||
        targets.every((file) => scope.has(owningWorkspacePackage(workspacePackages, file)))
      );
    },
  );
  if (!unused.length) return;
  const configFiles = doctorConfigFiles(session.root);
  const reported = session.diagnostics.length;
  for (const { suppression, index } of unused) {
    const entry = Object.entries(suppression)
      .filter(([key, value]) => key !== "reason" && typeof value === "string")
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ");
    const location = locateSuppression(configFiles, suppression, index);
    pushDiagnostic(session, {
      ruleId: "doctor/config/unused-suppression",
      severity: "info",
      category: "config",
      file: location?.file ?? resolve(session.root, "package.json"),
      range: location?.range,
      why: `The Doctor config suppression { ${entry} } matched no Diagnostic in this Doctor Run. Its reason was: ${suppression.reason}`,
      suggestion:
        "Delete this entry from the Doctor config suppressions. It no longer hides anything, and leaving it in place would silently hide a future Diagnostic that matches it.",
      confidence: "proven",
      analysisPhase: "manifest",
    });
  }
  session.diagnostics = [
    ...session.diagnostics.slice(0, reported),
    ...settleDiagnosticIdentity(session.diagnostics.slice(reported)),
  ];
}

function doctorConfigFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const order = ["doctor", "nuxt", "vite"];
  return entries
    .map((name) => ({
      name,
      match:
        /^(doctor)\.config\.(?:json5?|jsonc|ya?ml|toml|[cm]?[jt]s)$/.exec(name) ??
        /^\.(doctor)rc(?:\.json)?$/.exec(name) ??
        /^(nuxt|vite)\.config\.[cm]?[jt]s$/.exec(name),
    }))
    .filter((entry) => entry.match)
    .sort((a, b) => order.indexOf(a.match![1]!) - order.indexOf(b.match![1]!))
    .map((entry) => resolve(root, entry.name));
}

function locateSuppression(
  files: string[],
  suppression: NonNullable<DoctorConfig["suppressions"]>[number],
  index: number,
): { file: string; range?: Diagnostic["range"] } | undefined {
  const candidates: Array<{ file: string; opening: number; end: number }> = [];
  for (const file of files) {
    const source = readFileSyncIfExists(file);
    const section = source?.indexOf("suppressions") ?? -1;
    if (!source || section < 0) continue;
    const bounds = suppressionEntryBounds(source, section, index);
    const marker = suppression.reason || suppression.fingerprint || suppression.file;
    if (bounds && (!marker || source.slice(bounds.opening, bounds.end).includes(marker)))
      candidates.push({ file, ...bounds });
  }
  // Config merging does not retain source provenance. A precise range is safe only when
  // exactly one supported config can contain this indexed entry; otherwise avoid guessing.
  if (candidates.length !== 1) return undefined;
  const { file, opening } = candidates[0]!;
  const source = readFileSyncIfExists(file)!;
  return {
    file,
    range: { start: opening, end: opening + 1, ...lineColumnAt(source, opening) },
  };
}

function suppressionEntryBounds(
  source: string,
  section: number,
  index: number,
): { opening: number; end: number } | undefined {
  const array = source.indexOf("[", section);
  if (array < 0) return undefined;
  let depth = 0;
  let quote = "";
  let escaped = false;
  let found = 0;
  let opening: number | undefined;
  for (let position = array + 1; position < source.length; position++) {
    const char = source[position]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        if (found++ === index) opening = position;
      }
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && opening !== undefined) return { opening, end: position + 1 };
    } else if (char === "]" && depth === 0) break;
  }
  return undefined;
}

export function applyReportEligibility(session: ScanSession): void {
  if (!session.options.changed && !session.options.since) return;
  const eligibility = new Map(
    session.files.map((file) => [file.path, file.reportEligibility] as const),
  );
  const sources = { get: (file: string) => session.handlesByPath.get(file)?.text };
  // Parser evidence about files outside the change belongs to the full run, not this report.
  if (session.project.evidenceGaps)
    session.project.evidenceGaps = session.project.evidenceGaps.filter(
      (gap) =>
        (gap.source !== "script-parser" && gap.source !== "vue-sfc-parser") ||
        gap.files.some((file) => eligibility.get(file)),
    );
  session.diagnostics = session.diagnostics.filter((diagnostic) => {
    const locations = [diagnostic, ...(diagnostic.related ?? [])];
    return locations.some((location) => {
      const fileEligibility = eligibility.get(location.file);
      if (!fileEligibility) return false;
      if (!location.range) return diagnostic.range === undefined;
      const endLine = diagnosticEndLine(location.range, sources.get(location.file));
      return fileEligibility.ranges.some(
        (range) => location.range!.line <= range.endLine && endLine >= range.startLine,
      );
    });
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
  options: {
    root: string;
    includeUnsafe?: boolean;
    includeStructuralReview?: boolean;
  },
): AppliedFixes {
  const applied: AppliedFixes = { files: 0, edits: 0, skipped: 0 };
  const canonicalRoot = realpathSync(options.root);
  const byFile = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.fix) continue;
    if (diagnostic.fix.kind === "suggestion") continue;
    if (diagnostic.fix.kind === "unsafe" && !options.includeUnsafe) continue;
    if (diagnostic.fix.kind === "structural-review" && !options.includeStructuralReview) continue;
    let target: string;
    try {
      target = realpathSync(diagnostic.file);
    } catch {
      applied.skipped += diagnostic.fix.edits.length;
      continue;
    }
    if (!isPathInside(canonicalRoot, target)) {
      applied.skipped += diagnostic.fix.edits.length;
      continue;
    }
    const list = byFile.get(target) ?? [];
    list.push(diagnostic);
    byFile.set(target, list);
  }
  for (const [file, items] of byFile) {
    const candidates = uniqueFixEdits(items);
    let text: string;
    let original: Stats;
    try {
      original = statSync(file);
      text = readFileSync(file, "utf8");
    } catch {
      // A rule can report a generated or deleted source location. Keep the
      // finding reportable and account for unappliable edits instead of
      // aborting the run while trying to apply a fix.
      applied.skipped += candidates.length;
      continue;
    }
    const ms = new MagicString(text);
    const planned = planNonOverlappingFixes(candidates, text.length);
    const edits = [
      ...planned
        .filter((edit) => edit.range.start !== edit.range.end)
        .sort((a, b) => b.range.start - a.range.start),
      ...planned
        .filter((edit) => edit.range.start === edit.range.end)
        .sort((a, b) => b.range.start - a.range.start),
    ];
    applied.skipped += candidates.length - edits.length;
    if (!edits.length) continue;
    for (const edit of edits) {
      if (edit.range.start === edit.range.end) ms.appendLeft(edit.range.start, edit.text);
      else ms.overwrite(edit.range.start, edit.range.end, edit.text);
    }
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.vite-doctor-${process.pid}-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, ms.toString(), { mode: original.mode });
      let unchanged = false;
      try {
        const current = statSync(file);
        unchanged =
          current.dev === original.dev &&
          current.ino === original.ino &&
          current.mode === original.mode &&
          current.size === original.size &&
          current.mtimeMs === original.mtimeMs &&
          current.ctimeMs === original.ctimeMs &&
          readFileSync(file, "utf8") === text;
      } catch {
        unchanged = false;
      }
      if (!unchanged) {
        applied.skipped += edits.length;
        continue;
      }
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
  graph?: GraphSummary,
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
    graph,
    project,
  };
}

export function createDiagnosticFingerprint(
  root: string,
  diagnostic: Diagnostic,
  source: string | null,
): string {
  const rel = relative(root, diagnostic.file);
  const anchor = nearestAnchor(source ?? "", diagnostic.range?.start ?? 0);
  const message = diagnostic.why.replace(/\s+/g, " ");
  return sha256(`${diagnostic.ruleId}:${rel}:${anchor}:${message}`);
}

export function sourceTextFor(session: ScanSession, file: string): string | null {
  const path = resolve(session.root, file);
  const handle = session.handlesByPath.get(path);
  if (handle) return handle.text;
  const cached = session.sourceTexts.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSyncIfExists(path);
  session.sourceTexts.set(path, text);
  return text;
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
      createDiagnosticFingerprint(
        session.root,
        normalized,
        sourceTextFor(session, normalized.file),
      ),
  });
}

export function reportRuntimeInventoryUnknown(session: ScanSession): void {
  const nuxtRoots = workspaceNuxtRoots(session.project);
  // Without a run owner, the run graph is borrowed from a Nuxt app that reports it below.
  const ownerless =
    session.project.framework === "nuxt" && !session.project.nuxt && nuxtRoots.length;
  if (!ownerless) reportUnresolvedRuntime(session, session.project, ".");
  for (const root of nuxtRoots) {
    reportUnresolvedRuntime(session, workspaceProjectView(session.project, root), root);
  }
}

function reportUnresolvedRuntime(
  session: ScanSession,
  project: ProjectInfo,
  packageRoot: string,
): void {
  const packageJson = resolve(session.root, packageRoot, "package.json");
  const expected =
    project.framework === "nuxt"
      ? ["nuxt", "nitro", "h3"]
      : project.framework === "nitro"
        ? ["nitro", "h3"]
        : project.framework === "vue"
          ? ["vue"]
          : [];
  const unresolved = expected
    .map((runtime) => project.runtimeGraph?.packages[runtime as "nuxt" | "nitro" | "h3" | "vue"])
    .filter((item) => item?.state === "unknown");
  const details = [
    ...unresolved.map(
      (item) => `${item?.owner} -> ${item?.runtime}: ${item?.reason ?? "unresolved"}`,
    ),
    ...(project.nuxtCompatibility?.state === "unknown"
      ? [`Nuxt compatibility: ${project.nuxtCompatibility.reason ?? "unresolved"}`]
      : []),
  ];
  if (!details.length) return;
  const runtimeFix =
    "Install project dependencies and run Doctor from the target project package. If the project uses Yarn PnP, run Doctor through Yarn so its loader is active.";
  const compatibilityFix =
    "Make the effective future.compatibilityVersion statically provable in nuxt.config, or run pnpm nuxt doctor so the Nuxt integration can record the resolved value.";
  const compatibilityUnknown = project.nuxtCompatibility?.state === "unknown";
  pushDiagnostic(session, {
    ruleId: "doctor/inventory/unresolved-runtime",
    severity: "warn",
    category: "inventory",
    file:
      unresolved.length || !compatibilityUnknown
        ? packageJson
        : (project.nuxtCompatibility?.file ?? packageJson),
    why: `Doctor could not resolve the governing runtime graph${packageRoot === "." ? "" : ` of ${packageRoot}`}: ${details.join("; ")}`,
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
      ...(project.nuxtCompatibility?.state === "unknown"
        ? [
            {
              kind: "manifest" as const,
              summary: "Nuxt compatibility behavior is unresolved.",
              file: project.nuxtCompatibility?.file ?? project.nuxt?.manifestPath,
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

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== ".." && !relativePath.startsWith("../") && !isAbsolute(relativePath);
}

function uniqueFixEdits(items: Diagnostic[]): unknown[] {
  const edits = new Map<string, FixEdit>();
  const malformed: unknown[] = [];
  for (const edit of items.flatMap((item) => item.fix?.edits ?? [])) {
    if (!hasFixEditShape(edit)) {
      malformed.push(edit);
      continue;
    }
    edits.set(`${edit.range.start}:${edit.range.end}:${edit.text}`, edit);
  }
  return [...edits.values(), ...malformed];
}

function planNonOverlappingFixes(items: unknown[], sourceLength: number): FixEdit[] {
  const sorted = items
    .filter((edit): edit is FixEdit => isValidEdit(edit, sourceLength))
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

function hasFixEditShape(edit: unknown): edit is FixEdit {
  if (typeof edit !== "object" || edit === null || !("text" in edit) || !("range" in edit))
    return false;
  const range = edit.range;
  return (
    typeof edit.text === "string" &&
    typeof range === "object" &&
    range !== null &&
    "start" in range &&
    "end" in range &&
    typeof range.start === "number" &&
    typeof range.end === "number" &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start
  );
}

function isValidEdit(edit: unknown, sourceLength: number): edit is FixEdit {
  if (!hasFixEditShape(edit)) return false;
  return edit.range.end <= sourceLength;
}

function readFileSyncIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
