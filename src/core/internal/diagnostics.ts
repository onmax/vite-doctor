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
  DoctorFramework,
  NuxtCompatibilityInfo,
  ProjectInfo,
  RuntimePackageName,
  SourceRange,
} from "../primitives.js";
import { governingRuntimes } from "./runtime-packages.js";
import type { GraphSummary } from "./cache-store.js";
import { FINGERPRINT_SCHEME } from "../diagnostic-constants.js";
import { defaultConfigDiagnosticMetadata } from "../diagnostic-metadata.js";
import {
  applyDiagnosticPolicy,
  canMatchBroadConfigSuppression,
  InlineSuppressionIndex,
  settleDiagnosticIdentity,
  matchesSuppressionFile,
  unusedConfigSuppressionEntries,
  type BaselineEntry,
  type InlineSuppression,
  type StaleBaseline,
} from "./diagnostic-policy.js";
import { hasRuleSourceCoverage, isTestFileHandle } from "./facts.js";
import { collectExternalGitChanges } from "./git-change-ranges.js";
import { lineColumnAt } from "./line-index.js";
import { workspaceNuxtRoots, workspaceProjectView } from "./workspace-nuxt.js";
import { owningWorkspacePackage } from "./workspace-packages.js";
import {
  analyzesTestFiles,
  fileRuleConfig,
  markSession,
  topLevelRuleConfig,
  type ScanSession,
} from "./scan-session.js";
import { GitChangeUnavailableError, type ScanFileEntry } from "./source-inventory.js";
import { scoreDiagnostics } from "./scoring.js";
import { VERSION, sha256, shellArgument } from "./utils.js";
import {
  allDiagnosticCodeListsByRuleId,
  allDiagnosticCodesByRuleId,
  allDiagnostics,
} from "../diagnostic-code-map.js";
import { codeForRuleId, diagnosticForCode } from "../diagnostics.js";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import type { Diagnostic as NosticsDiagnostic } from "nostics";

export interface AppliedFixes {
  files: number;
  edits: number;
  skipped: number;
}

export const scopedReportLocations = Symbol("scoped report locations");

type ScopedReportLocations = {
  [scopedReportLocations]?: readonly { file: string; range: SourceRange }[];
};

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

export async function applyPolicyFilters(session: ScanSession): Promise<void> {
  session.diagnostics = settleDiagnosticIdentity(session.diagnostics);
  reportUnusedInlineSuppressions(session);
  reportUnusedConfigSuppressions(session);
  reportDefaultDeclarativeConfig(session);
  await applyReportEligibility(session);
  applySeverityFilter(session);
  const beforeOverlapSelection = session.diagnostics;
  const result = applyDiagnosticPolicy(session, preferModuleStateDiagnostics);
  session.diagnostics = result.diagnostics;
  session.suppressedDiagnostics = result.suppressedDiagnostics;
  if (result.staleBaseline) reportStaleBaseline(session, result.staleBaseline);
  if (result.baseline)
    reportResolvedBaselineEntries(session, result.baseline, beforeOverlapSelection);
}

const moduleStateReplacements = new Map([
  ["NUXT0105", "NUXT0084"],
  ["NITRO0023", "NITRO0035"],
]);

function preferModuleStateDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const overlapKey = ({ code, file, range }: Diagnostic) => {
    if (!range) return undefined;
    const preferred = moduleStateReplacements.get(code) ?? code;
    if (preferred !== "NUXT0084" && preferred !== "NITRO0035") return undefined;
    return JSON.stringify([preferred, file, range.start, range.end]);
  };
  const winners = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) {
    const key = overlapKey(diagnostic);
    if (!key) continue;
    const winner = winners.get(key);
    const rank = severityRank(diagnostic.severity);
    if (
      !winner ||
      rank > severityRank(winner.severity) ||
      (rank === severityRank(winner.severity) && !moduleStateReplacements.has(diagnostic.code))
    )
      winners.set(key, diagnostic);
  }
  if (!winners.size) return diagnostics;
  return diagnostics.filter((diagnostic) => {
    const key = overlapKey(diagnostic);
    return !key || winners.get(key)?.code === diagnostic.code;
  });
}

function reportStaleBaseline(session: ScanSession, baseline: StaleBaseline): void {
  const ruleId = "doctor/baseline/stale-fingerprint-scheme";
  const severity = configuredDiagnosticSeverity(session, ruleId, baseline.file, "warn");
  if (!severity || !meetsMinimumSeverity(session, severity)) return;
  const path = relative(session.root, baseline.file) || baseline.file;
  const writer =
    baseline.fingerprintScheme === undefined
      ? "does not record the fingerprint scheme it was written with"
      : `was written with fingerprint scheme ${baseline.fingerprintScheme}`;
  const warning = normalizeDiagnosticFromRuleCode({
    ruleId,
    severity,
    category: "baseline",
    file: baseline.file,
    why: `Baseline "${path}"${baseline.doctorVersion ? ` (Doctor ${baseline.doctorVersion})` : ""} ${writer}, but this Doctor uses fingerprint scheme ${FINGERPRINT_SCHEME}. Recorded findings whose fingerprints changed are reported as new by --new-only.`,
    suggestion: `Regenerate the baseline with a full Doctor Run, without --changed, --since, or --rules: vite-doctor . --baseline ${shellArgument(path)} --update-baseline. Then commit the updated baseline.`,
    confidence: "proven",
    analysisPhase: "manifest",
  });
  pushBaselineDiagnostic(session, warning);
}

// A missing fingerprint only proves resolution when a full run covered the recorded file,
// or proved that the file or required syntax is gone. For Rules that execute or report across
// files, the baseline location alone does not identify the inputs needed to reproduce the finding.
function reportResolvedBaselineEntries(
  session: ScanSession,
  baseline: { file: string; entries: BaselineEntry[] },
  emittedDiagnostics: Diagnostic[],
): void {
  const { options, root } = session;
  if (session.scopedReport || options.rules || options.analyses) return;
  // A threshold above info drops findings before the baseline sees them, so resolution is unproven.
  if (!meetsMinimumSeverity(session, "info")) return;
  const ruleId = "doctor/baseline/resolved-entries";
  const severity = configuredDiagnosticSeverity(session, ruleId, baseline.file, "info");
  if (!severity) return;
  const reported = new Set(emittedDiagnostics.map((diagnostic) => diagnostic.fingerprint));
  const coverage = ruleCoverage(session);
  const fileRules = new Map(
    session.enabledRules
      .filter(
        (rule) => (rule.meta.execution ?? "file") === "file" && rule.meta.reportScope !== "project",
      )
      .map((rule) => [rule.meta.id, rule] as const),
  );
  const resolved = baseline.entries.filter(({ fingerprint, ruleId, file }) => {
    if (reported.has(fingerprint) || !ruleId || !file) return false;
    const rule = fileRules.get(ruleId);
    if (!rule || coverage.partial.has(ruleId) || !topLevelRuleConfig(session, ruleId).enabled)
      return false;
    const path = resolve(root, file);
    if (
      coverage.unproven.has(relative(root, path)) ||
      !fileRuleConfig(session, ruleId, path).enabled
    )
      return false;
    const handle = session.handlesByPath.get(path);
    if (handle && isTestFileHandle(handle) && !analyzesTestFiles(rule)) return false;
    return handle ? hasRuleSourceCoverage(rule, handle) : !existsSync(path);
  });
  if (!resolved.length) return;
  const path = relative(root, baseline.file) || baseline.file;
  const findings = resolved.length === 1 ? "1 finding" : `${resolved.length} findings`;
  const diagnostic = normalizeDiagnosticFromRuleCode({
    ruleId,
    severity,
    category: "baseline",
    file: baseline.file,
    why: `Baseline "${path}" records ${findings} that this full Doctor Run no longer reports. While the entries stay, --new-only hides the same findings if they come back.`,
    suggestion: `Delete only the fingerprints listed in this Diagnostic's evidence from "${path}". Leave the other entries in place and commit the updated baseline.`,
    confidence: "proven",
    analysisPhase: "manifest",
    evidence: resolved.map((entry) => ({
      kind: "manifest" as const,
      summary: `${entry.ruleId} no longer reports fingerprint ${entry.fingerprint} in ${entry.file}.`,
      file: resolve(root, entry.file!),
    })),
  });
  pushBaselineDiagnostic(session, diagnostic);
}

// The baseline is not a source file, so its Diagnostics skip scope filtering but follow the
// same suppression policy as every other Diagnostic.
function pushBaselineDiagnostic(session: ScanSession, diagnostic: Diagnostic): void {
  diagnostic.fingerprint ??= createDiagnosticFingerprint(
    session.root,
    diagnostic,
    sourceTextFor(session, diagnostic.file),
  );
  const result = applyDiagnosticPolicy({
    root: session.root,
    config: session.config,
    options: { ...session.options, updateBaseline: false },
    diagnostics: [diagnostic],
  });
  session.diagnostics.push(...result.diagnostics);
  session.suppressedDiagnostics.push(...result.suppressedDiagnostics);
}

function ruleCoverage(session: ScanSession) {
  const { root } = session;
  const workspacePackages = session.project.workspacePackages ?? [];
  return {
    ran: new Set(session.enabledRules.map((rule) => rule.meta.id)),
    // A Rule that runs on only some files cannot prove a finding or suppression stale.
    partial: new Set([
      ...session.overrideOnlyRules,
      ...session.ruleOverrides.flatMap((override) =>
        [...override.rules].flatMap(([ruleId, config]) => (config.enabled ? [] : [ruleId])),
      ),
    ]),
    analyzed: new Set(session.files.map((file) => relative(root, file.path))),
    unproven: new Set(
      (session.project.evidenceGaps ?? []).flatMap((gap) =>
        gap.files.map((file) => relative(root, resolve(root, file))),
      ),
    ),
    workspacePackages,
  };
}

// A Rule ID is proven stale on a file only when the Rule ran there and reported nothing the
// directive covers. Rules that did not run (turned off, outside the selected Presets or Rules, an
// inactive Rule Pack, a file the Rule cannot read) leave the directive alone, so partial runs stay
// quiet. Changed-file runs drop reports outside the change through report eligibility afterwards.
function reportUnusedInlineSuppressions(session: ScanSession): void {
  if (!session.fileRuleRuns.size) return;
  const index = new InlineSuppressionIndex((file) => session.handlesByPath.get(file)?.text);
  const used = new Map<InlineSuppression, Set<string>>();
  const byFile = new Map<string, Diagnostic[]>();
  for (const diagnostic of session.diagnostics) {
    if (!session.fileRuleRuns.has(diagnostic.file)) continue;
    const list = byFile.get(diagnostic.file) ?? [];
    list.push(diagnostic);
    byFile.set(diagnostic.file, list);
    for (const directive of index.matching(diagnostic)) {
      const rules = used.get(directive) ?? new Set<string>();
      rules.add(diagnostic.ruleId);
      used.set(directive, rules);
    }
  }
  const registered = new Map(session.registry.rules.map((rule) => [rule.meta.id, rule] as const));
  const namespaces = new Set([...registered.keys()].map(ruleNamespace));
  const codeOwners = diagnosticCodeOwners(session);
  const unproven = new Set(
    (session.project.evidenceGaps ?? []).flatMap((gap) =>
      gap.files.map((file) => resolve(session.root, file)),
    ),
  );
  const reported = session.diagnostics.length;
  for (const [file, ran] of session.fileRuleRuns) {
    if (unproven.has(file)) continue;
    const handle = session.handlesByPath.get(file);
    if (!handle) continue;
    const directives = index.directives(file);
    const sameLineCount = directives.filter((directive) => !directive.nextLine).length;
    for (const directive of directives) {
      if (directive.rules.some((rule) => rule.id === "*")) continue;
      const matched = used.get(directive);
      const unused: string[] = [];
      const unknown: Array<{ id: string; owner?: string }> = [];
      for (const { id } of directive.rules) {
        if (matched?.has(id)) continue;
        const rule = registered.get(id);
        if (rule) {
          // Rules that read the environment or a live runtime can stay quiet for reasons this run cannot see.
          const deterministic = (rule.meta.determinism ?? "deterministic") === "deterministic";
          if (ran.has(id) && deterministic) unused.push(id);
        } else if (DIAGNOSTIC_CODE.test(id)) unknown.push({ id, owner: codeOwners.get(id) });
        else if (namespaces.has(ruleNamespace(id)) && !(id in allDiagnosticCodesByRuleId))
          unknown.push({ id });
      }
      if (!unused.length && !unknown.length) continue;
      const unusedRuleId = "doctor/inline/unused-suppression";
      const unknownRuleId = "doctor/inline/unknown-suppression-rule";
      const removable = (ruleId: string) => {
        const severity = configuredDiagnosticSeverity(session, ruleId, file, "info");
        return severity !== undefined && meetsMinimumSeverity(session, severity);
      };
      const removed = [
        ...(unused.length && removable(unusedRuleId) ? unused : []),
        ...(unknown.length && removable(unknownRuleId) ? unknown.map(({ id }) => id) : []),
      ];
      const fix = removed.length
        ? inlineSuppressionFix(
            handle.text,
            directive,
            removed,
            sameLineCount > (directive.nextLine ? 0 : 1),
          )
        : undefined;
      const text = handle.text.slice(directive.start, directive.list.end);
      const range = {
        start: directive.start,
        end: directive.end,
        ...lineColumnAt(handle.text, directive.start),
      };
      if (unused.length)
        pushDiagnostic(session, {
          ruleId: unusedRuleId,
          severity: "info",
          category: "suppression",
          file,
          range,
          why: `The directive "${text}" suppressed no ${unused.join(", ")} Diagnostic in this Doctor Run, although ${unused.length === 1 ? "that Rule" : "those Rules"} ran on this file.${misplacedHint(byFile.get(file) ?? [], index, directive, unused)} Its reason was: ${directive.reason}`,
          suggestion: `Remove ${unused.join(", ")} from the directive. It no longer hides anything, and leaving it in place would silently hide a future Diagnostic on this line.`,
          fix,
          confidence: "proven",
          analysisPhase: "file",
        });
      if (unknown.length)
        pushDiagnostic(session, {
          ruleId: unknownRuleId,
          severity: "info",
          category: "suppression",
          file,
          range,
          why: `The directive "${text}" names ${unknown.map((item) => item.id).join(", ")}, which ${unknown.length === 1 ? "is not a Rule ID" : "are not Rule IDs"} in this Doctor Run, so it suppresses nothing.`,
          suggestion: [
            ...unknown.map((item) =>
              item.owner
                ? `${item.id} is a Diagnostic Code; directives name Rule IDs, so write ${item.owner} if the Diagnostic should stay suppressed.`
                : `${item.id} may have been renamed or removed; run \`vite-doctor rules\` for current Rule IDs.`,
            ),
            "Otherwise remove it from the directive.",
          ].join(" "),
          fix,
          confidence: "proven",
          analysisPhase: "file",
        });
    }
  }
  session.diagnostics = [
    ...session.diagnostics.slice(0, reported),
    ...settleDiagnosticIdentity(session.diagnostics.slice(reported)),
  ];
}

// A Diagnostic of the same Rule just below, which no directive covers, usually means the
// directive sits on the wrong line rather than that the finding went away.
function misplacedHint(
  diagnostics: Diagnostic[],
  index: InlineSuppressionIndex,
  directive: InlineSuppression,
  rules: string[],
): string {
  const line = directive.line + 1;
  const nearby = diagnostics.find(
    (diagnostic) =>
      rules.includes(diagnostic.ruleId) &&
      diagnostic.range &&
      diagnostic.range.line > line &&
      diagnostic.range.line <= line + 5 &&
      !index.matching(diagnostic).length,
  );
  return nearby
    ? ` Doctor still reports ${nearby.code} on line ${nearby.range!.line}, which this directive does not cover, so it may be on the wrong line.`
    : "";
}

const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9]*\d{4}$/;

function ruleNamespace(ruleId: string): string {
  return ruleId.split("/")[0]!;
}

function diagnosticCodeOwners(session: ScanSession): Map<string, string> {
  const owners = new Map<string, string>();
  const add = (lists: Readonly<Record<string, readonly string[] | undefined>> | undefined) => {
    for (const [ruleId, codes] of Object.entries(lists ?? {}))
      for (const code of codes ?? []) if (!owners.has(code)) owners.set(code, ruleId);
  };
  for (const pack of session.registry.packs) add(pack.diagnostics?.codesByRuleIdAll);
  for (const rule of session.registry.rules) add({ [rule.meta.id]: rule.meta.diagnosticCodes });
  add(allDiagnosticCodeListsByRuleId);
  return owners;
}

// Rules read comment text too: a SAFETY note in a directive's reason is what keeps an assertion
// Rule quiet, so deleting it would bring that finding back.
const SAFETY_NOTE = /(?:^|[^\p{L}\p{N}_])SAFETY\s*(?::|$)/u;

function inlineSuppressionFix(
  source: string,
  directive: InlineSuppression,
  removed: string[],
  hasOtherSameLineDirective: boolean,
): Diagnostic["fix"] {
  const kept = directive.rules.filter((rule) => !removed.includes(rule.id)).map((rule) => rule.id);
  if (kept.length)
    return {
      kind: "safe",
      message: `Keep only ${kept.join(", ")} in the directive.`,
      edits: [{ range: directive.list, text: kept.join(",") }],
    };
  if (directive.reasonRange && SAFETY_NOTE.test(directive.reason))
    return {
      kind:
        directive.shadowing || directive.reason.includes("doctor-disable") ? "suggestion" : "safe",
      message: "Delete the directive and keep its reason, which other Rules read as a SAFETY note.",
      edits: [{ range: { start: directive.start, end: directive.reasonRange.start }, text: "" }],
    };
  const { range, text } = directive.removal ?? {
    range: { start: directive.start, end: directive.end },
    text: "",
  };
  const shifts =
    hasOtherSameLineDirective &&
    !text.includes("\n") &&
    source.slice(range.start, range.end).includes("\n");
  return {
    kind: shifts || directive.shadowing ? "suggestion" : "safe",
    message: "Delete the directive.",
    edits: [{ range, text }],
  };
}

// Scoped runs skip Rules or files, so a suppression can match nothing without being stale.
function reportUnusedConfigSuppressions(session: ScanSession): void {
  const { options, root } = session;
  if (session.scopedReport || options.rules || options.analyses) return;
  const { ran, partial, analyzed, unproven, workspacePackages } = ruleCoverage(session);
  const effectiveExtends = options.extends ?? session.config.extends;
  // An entry without a Rule may belong to a Rule turned off in config, which cannot prove it stale.
  const selectsActivated = (entry: string) => entry === "auto" || entry === "strict";
  const unscoped =
    session.coversConfiguredPresets &&
    (effectiveExtends === undefined ||
      (typeof effectiveExtends === "string"
        ? selectsActivated(effectiveExtends)
        : effectiveExtends.some(selectsActivated))) &&
    ![...session.ruleConfigs].some(
      ([ruleId, config]) => !config.enabled && canMatchBroadConfigSuppression(ruleId),
    ) &&
    !session.ruleOverrides.some(
      (override) =>
        override.selects.size > 0 ||
        [...override.rules.keys()].some(canMatchBroadConfigSuppression),
    );
  const workspaceRoots = new Set(workspacePackages.map((item) => item.root));
  const coversWorkspace = (scope: ReadonlySet<string> | undefined): boolean =>
    !scope || [...workspaceRoots].every((root) => scope.has(root));
  const unused = unusedConfigSuppressionEntries(root, session.config, session.diagnostics).filter(
    ({ suppression }) => {
      if (suppression.ruleId ? !ran.has(suppression.ruleId) : !unscoped) return false;
      if (suppression.ruleId && partial.has(suppression.ruleId)) return false;
      const scope = suppression.ruleId ? session.ruleScopes.get(suppression.ruleId) : undefined;
      // A broad suppression is inconclusive when its Rule only ran in part of the workspace.
      if (!suppression.file && !coversWorkspace(scope)) return false;
      const pattern = suppression.file;
      if (!pattern) return unproven.size === 0;
      // The source inventory may omit files matched by a glob (for example excluded,
      // ignored, or otherwise unavailable files). Without a complete target set we
      // cannot prove that a wildcard suppression is stale.
      if (isGlobPattern(pattern)) return false;
      let targets = [...analyzed].filter((file) => matchesSuppressionFile(file, pattern));
      // Only a literal path that no longer exists is provably stale; any other unanalyzed
      // target may be excluded, ignored, or outside the source inventory.
      if (!targets.length) {
        // A basename is matched by `nativeMatch` as a substring (for example,
        // `main.ts` matches `src/main.ts`). An omitted file can therefore still
        // satisfy this suppression even when no analyzed target is available.
        if (isGlobPattern(pattern) || !pattern.includes("/") || existsSync(resolve(root, pattern)))
          return false;
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

function reportDefaultDeclarativeConfig(session: ScanSession): void {
  const { options } = session;
  const file = options.declarativeConfigFile;
  const value = options.config;
  if (!file || !value || session.scopedReport || options.rules || options.analyses) return;
  if (!selectsOnlyDefaults(value) || !selectsOnlyDefaults(shadowedHostSettings(session, value)))
    return;
  const { ruleId, severity, category, fix } = defaultConfigDiagnosticMetadata;
  const reported = session.diagnostics.length;
  pushDiagnostic(session, {
    ruleId,
    severity,
    category,
    file,
    why: "doctor.config.json selects nothing beyond Doctor's defaults, so this Doctor Run is the same without it. Doctor needs no config file: it activates Rule Packs from the project's dependencies.",
    suggestion: fix,
    confidence: "proven",
    analysisPhase: "manifest",
  });
  session.diagnostics = [
    ...session.diagnostics.slice(0, reported),
    ...settleDiagnosticIdentity(session.diagnostics.slice(reported)),
  ];
}

function shadowedHostSettings(session: ScanSession, config: DoctorConfig) {
  const inherited = session.project.nuxt?.doctorConfig;
  return Object.fromEntries(
    (["extends", "exclude", "suppressions"] as const)
      .filter((key) => config[key] !== undefined && inherited?.[key] !== undefined)
      .map((key) => [key, inherited?.[key]]),
  );
}

// `include: []` and `extends: []` select no files or no Rules, so only these values match the defaults.
function selectsOnlyDefaults(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    switch (key) {
      case "$schema":
        return true;
      case "extends":
        return (
          entry === "auto" ||
          (Array.isArray(entry) && entry.length > 0 && entry.every((item) => item === "auto"))
        );
      case "exclude":
      case "overrides":
      case "suppressions":
        return Array.isArray(entry) && entry.length === 0;
      case "rules":
      case "cache":
        return isPlainObject(entry) && Object.keys(entry).length === 0;
      case "score":
        return (
          isPlainObject(entry) &&
          Object.entries(entry).every(
            ([name, weights]) =>
              name === "weights" && isPlainObject(weights) && Object.keys(weights).length === 0,
          )
        );
      default:
        return false;
    }
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGlobPattern(pattern: string): boolean {
  // `nativeMatch` accepts multiple glob forms; any of them may match files
  // omitted from the source inventory, so their unused status is inconclusive.
  return /[*?[\]{}]/.test(pattern);
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
  let suppressionSources = 0;
  for (const file of files) {
    const source = readFileSyncIfExists(file);
    const section = source?.indexOf("suppressions") ?? -1;
    if (!source || section < 0) continue;
    suppressionSources++;
    const bounds = suppressionEntryBounds(source, section, index);
    const marker = suppression.reason || suppression.fingerprint || suppression.file;
    if (bounds && (!marker || source.slice(bounds.opening, bounds.end).includes(marker)))
      candidates.push({ file, ...bounds });
  }
  // Config merging does not retain source provenance. A precise range is safe only when
  // exactly one supported config supplies suppressions; otherwise avoid guessing.
  if (suppressionSources !== 1 || candidates.length !== 1) return undefined;
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

async function applyReportEligibility(session: ScanSession): Promise<void> {
  if (!session.scopedReport) return;
  const eligibility = new Map<string, ScanFileEntry["reportEligibility"]>(
    [...session.files, ...session.testFiles].map(
      (file) => [file.path, file.reportEligibility] as const,
    ),
  );
  // Files outside the source inventory, such as package.json and pnpm-lock.yaml, still carry
  // Diagnostics and manifest evidence, so their changed lines count like a source file's.
  const affected =
    session.options.affectedFiles &&
    new Set(session.options.affectedFiles.map((file) => resolve(session.root, file)));
  for (const change of session.gitChanges?.files ?? []) {
    if (!change.path) continue;
    const path = resolve(session.root, change.path);
    if (!eligibility.has(path) && (!affected || affected.has(path)))
      eligibility.set(path, {
        kind: "changed-lines",
        get ranges() {
          return change.reportRanges;
        },
      });
  }
  const projectRules = new Set(
    session.enabledRules
      .filter(
        ({ meta }) =>
          meta.execution === "manifest" ||
          meta.execution === "workspace" ||
          meta.reportScope === "project",
      )
      .map(({ meta }) => meta.id),
  );
  const manifestEvidence = (diagnostic: Diagnostic) =>
    !projectRules.has(diagnostic.ruleId)
      ? []
      : (diagnostic.evidence ?? []).flatMap(({ kind, file, range }) =>
          kind === "manifest" && file && range
            ? [{ file: resolve(session.root, file), range }]
            : [],
        );
  const external = new Map<string, NonNullable<ScanFileEntry["reportEligibility"]>>();
  if (session.gitChanges) {
    const files = new Set<string>();
    for (const diagnostic of session.diagnostics) {
      for (const { file } of manifestEvidence(diagnostic)) {
        if (!isPathInside(session.root, file) && (!affected || affected.has(file))) files.add(file);
      }
    }
    if (files.size) {
      const changes = await collectExternalGitChanges(
        session.root,
        session.gitChanges.base,
        [...files],
        session.options.since,
      );
      if (changes.status === "unavailable") throw new GitChangeUnavailableError(changes);
      for (const change of changes.files) {
        if (!change.path) continue;
        external.set(resolve(session.root, change.path), {
          kind: "changed-lines",
          get ranges() {
            return change.reportRanges;
          },
        });
      }
    }
  }
  const texts = new Map<string, string | undefined>();
  const sources = {
    get(file: string) {
      const handle = session.handlesByPath.get(file);
      if (handle) return handle.text;
      if (!texts.has(file)) texts.set(file, readTextOrUndefined(file));
      return texts.get(file);
    },
  };
  // Parser evidence about files outside the change belongs to the full run, not this report.
  if (session.project.evidenceGaps)
    session.project.evidenceGaps = session.project.evidenceGaps.filter(
      (gap) =>
        (gap.source !== "script-parser" && gap.source !== "vue-sfc-parser") ||
        gap.files.some((file) => eligibility.get(file)),
    );
  const onChangedLine = (
    file: string,
    range: SourceRange,
    fileEligibility = eligibility.get(file),
  ) => {
    if (!fileEligibility) return false;
    if (fileEligibility.kind === "file") return true;
    const endLine = diagnosticEndLine(range, sources.get(file));
    return fileEligibility.ranges.some(
      (changed) => range.line <= changed.endLine && endLine >= changed.startLine,
    );
  };
  session.diagnostics = session.diagnostics.filter(
    (diagnostic: Diagnostic & ScopedReportLocations) => {
      const scopeLocations = diagnostic[scopedReportLocations];
      delete diagnostic[scopedReportLocations];
      const locations = [diagnostic, ...(diagnostic.related ?? [])];
      const located = locations.some((location) => {
        if (location.range) return onChangedLine(location.file, location.range);
        return diagnostic.range === undefined && eligibility.get(location.file) !== undefined;
      });
      // A manifest or lockfile entry is the cause of the finding even when the finding is
      // reported elsewhere, such as a lockfile route that reaches a second copy.
      return (
        located ||
        scopeLocations?.some(({ file, range }) => onChangedLine(file, range)) ||
        manifestEvidence(diagnostic).some(({ file, range }) =>
          onChangedLine(file, range, eligibility.get(file) ?? external.get(file)),
        )
      );
    },
  );
}

function readTextOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function diagnosticEndLine(range: NonNullable<Diagnostic["range"]>, source?: string): number {
  if (!source || range.end <= range.start) return range.line;
  const newlines = source.slice(range.start, range.end - 1).match(/\n/g)?.length ?? 0;
  return range.line + newlines;
}

function applySeverityFilter(session: ScanSession): void {
  if (!session.options.severity) return;
  session.diagnostics = session.diagnostics.filter((diagnostic) =>
    meetsMinimumSeverity(session, diagnostic.severity),
  );
}

function meetsMinimumSeverity(session: ScanSession, severity: DoctorSeverity): boolean {
  const minimum = session.options.severity;
  return !minimum || severityRank(severity) >= severityRank(minimum);
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
    reportVersion: 4,
    framework: rootFramework(project),
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

// A single-package run's framework is the root's own, including a caller's override. In a
// workspace the run framework is a pick across packages, so the root reports its own entry.
function rootFramework(project: ProjectInfo): DoctorFramework {
  const packages = project.workspacePackages ?? [];
  if (packages.length <= 1) return project.framework;
  return packages.find((item) => item.root === ".")?.framework ?? project.framework;
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

function configuredDiagnosticSeverity(
  session: ScanSession,
  ruleId: string,
  file: string,
  fallback: DoctorSeverity,
): DoctorSeverity | undefined {
  const config = fileRuleConfig(session, ruleId, file);
  return config.enabled ? (config.severity ?? fallback) : undefined;
}

export function pushDiagnostic(
  session: ScanSession,
  diagnostic: Partial<Diagnostic> &
    ScopedReportLocations & {
      ruleId: string;
      severity: Diagnostic["severity"];
      category: string;
      message?: string;
      why?: string;
      suggestion: string;
      file: string;
    },
): void {
  const severity = configuredDiagnosticSeverity(
    session,
    diagnostic.ruleId,
    diagnostic.file,
    diagnostic.severity,
  );
  if (!severity) return;
  const normalized = normalizeDiagnosticFromRuleCode({ ...diagnostic, severity });
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
  const project = session.project;
  const nuxtRoots = workspaceNuxtRoots(project);
  // Without a run owner, the run graph is borrowed from a Nuxt app that reports it below.
  const ownerless = project.framework === "nuxt" && !project.nuxt && nuxtRoots.length;
  if (!ownerless)
    reportUnresolvedRuntime(
      session,
      project,
      ".",
      governingRuntimes(project.framework, project.runtimeGraph),
      project.nuxtCompatibility,
    );
  for (const root of nuxtRoots) {
    const view = workspaceProjectView(project, root);
    reportUnresolvedRuntime(
      session,
      view,
      root,
      governingRuntimes("nuxt", view.runtimeGraph),
      view.nuxtCompatibility,
    );
  }
  // The rest of these graphs is the run's, reported above.
  for (const root of Object.keys(project.workspaceRuntimeGraphs ?? {}))
    reportUnresolvedRuntime(session, workspaceProjectView(project, root), root, ["h3"], undefined);
}

function reportUnresolvedRuntime(
  session: ScanSession,
  project: ProjectInfo,
  packageRoot: string,
  expected: readonly RuntimePackageName[],
  compatibility: NuxtCompatibilityInfo | undefined,
): void {
  const packageJson = resolve(session.root, packageRoot, "package.json");
  const unresolved = expected
    .map((runtime) => project.runtimeGraph?.packages[runtime])
    .filter((item) => item?.state === "unknown");
  const details = [
    ...unresolved.map(
      (item) => `${item?.owner} -> ${item?.runtime}: ${item?.reason ?? "unresolved"}`,
    ),
    ...(compatibility?.state === "unknown"
      ? [`Nuxt compatibility: ${compatibility.reason ?? "unresolved"}`]
      : []),
  ];
  if (!details.length) return;
  const dangling = unresolved.filter((item) => item?.danglingLink);
  const runtimeFix = dangling.length
    ? `Reinstall dependencies with the project package manager to recreate the dangling ${dangling.map((item) => item!.danglingLink!.path).join(", ")} link${dangling.length > 1 ? "s" : ""}, then rerun Doctor.`
    : "Install project dependencies and run Doctor from the target project package. If the project uses Yarn PnP, run Doctor through Yarn so its loader is active.";
  const compatibilityFix =
    "Make the effective future.compatibilityVersion statically provable in nuxt.config, or run pnpm nuxt doctor so the Nuxt integration can record the resolved value.";
  const compatibilityUnknown = compatibility?.state === "unknown";
  pushDiagnostic(session, {
    ruleId: "doctor/inventory/unresolved-runtime",
    severity: "warn",
    category: "inventory",
    file:
      unresolved.length || !compatibilityUnknown
        ? packageJson
        : (compatibility?.file ?? packageJson),
    why: `Doctor could not resolve the governing runtime graph${packageRoot === "." ? "" : ` of ${packageRoot}`}: ${details.join("; ")}`,
    suggestion: [
      unresolved.length ? runtimeFix : undefined,
      compatibilityUnknown ? compatibilityFix : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    evidence: [
      ...unresolved.map((item) =>
        item?.danglingLink
          ? {
              kind: "manifest" as const,
              summary: `${item.owner} -> ${item.runtime} goes through a symlink to ${item.danglingLink.target}, which does not exist.`,
              file: item.danglingLink.path,
            }
          : {
              kind: "manifest" as const,
              summary: `${item?.owner} -> ${item?.runtime} is unresolved.`,
              file: item?.packageJsonPath,
            },
      ),
      ...(compatibility?.state === "unknown"
        ? [
            {
              kind: "manifest" as const,
              summary: "Nuxt compatibility behavior is unresolved.",
              file: compatibility?.file ?? project.nuxt?.manifestPath,
            },
          ]
        : []),
    ],
    confidence: "manifest-backed",
    analysisPhase: "manifest",
  });
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
