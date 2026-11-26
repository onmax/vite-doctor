import { relative } from "pathe";
import { isMcpHeaderName } from "../mcp/endpoint.js";
import pc from "picocolors";
import { formatDiagnostic } from "nostics";
import type {
  Confidence,
  Diagnostic,
  DiagnosticEvidence,
  DoctorReportFormat,
  DoctorRunResult,
  DoctorSeverity,
  FixSafety,
  RulePack,
} from "./primitives.js";
import {
  allDiagnosticCodeListsByRuleId,
  allDiagnosticCodesByRuleId,
} from "./diagnostic-code-map.js";
import { DOCTOR_DIAGNOSTICS_DOCS_BASE, FINGERPRINT_SCHEME } from "./diagnostic-constants.js";
import { codeForRuleId } from "./diagnostics.js";
import { diagnosticMetadataByCode, diagnosticMetadataByRuleId } from "./diagnostic-metadata.js";
import type { DoctorRunOptions } from "./config.js";
import { shellArgument } from "./internal/utils.js";
import { scoreDiagnostics } from "./internal/scoring.js";
import {
  type BudgetGroup,
  type BudgetHidden,
  type GroupShown,
  DEFAULT_REPORT_BUDGET,
  hasHidden,
  hiddenCounts,
  planReportBudget,
  shownGroups,
} from "./internal/report-budget.js";

export interface DoctorReportContext {
  runOptions?: Readonly<DoctorRunOptions>;
  /** Executable configuration explicitly selected by the CLI caller. */
  configFile?: string;
  /** Directory the caller ran Doctor from. Text report commands name the project relative to it. */
  cwd?: string;
  /** The `--format` the caller passed, which text report commands repeat. */
  formatFlag?: DoctorReportFormat;
  /** Plugin reports point at plugin options instead of CLI commands. */
  surface?: "cli" | "plugin";
}

const SEVERITIES = ["blocker", "error", "warn", "info"] as const;

/** Diagnostics that share a severity, Diagnostic Code and confidence, in report order. */
interface ReportGroup {
  key: string;
  severity: DoctorSeverity;
  code: string;
  ruleId: string;
  title: string;
  confidence?: Confidence;
  docs?: string;
  diagnostics: Diagnostic[];
  /** The remediation every Diagnostic of the group shares. */
  fix?: string;
  /** Evidence printed once for the group, with how many of its Diagnostics carry it. */
  evidence: Array<{ item: DiagnosticEvidence; count: number }>;
}

/** Extra flags of a group's `more` hint, such as `--rules <ruleId> --full`. */
type GroupHint = string[];

interface ProgressiveLayout {
  /** Head, tail and the longest footer, which a plan can never cut. */
  fixed: number;
  groups: BudgetGroup[];
  render(shown: GroupShown[], hints: Array<GroupHint | undefined>): string;
}

interface ProgressiveOutcome {
  report: string;
  groups: ReportGroup[];
  shown: GroupShown[];
}

export function createTextReport(
  result: DoctorRunResult,
  context: DoctorReportContext = {},
): string {
  return progressiveReport(result, context, "text", reportBudget(context), true).report.slice(
    0,
    -1,
  );
}

/** One Diagnostic as the text report renders it, indented for a severity section. */
export function formatTextDiagnostic(root: string, diagnostic: Diagnostic): string {
  return textDiagnosticBlock(diagnosticLocation(root, diagnostic), diagnostic);
}

function textDiagnosticBlock(source: string, diagnostic: Diagnostic): string {
  return [
    indent(formatDiagnostic(diagnostic.diagnostic), "  "),
    `    rule: ${diagnostic.ruleId}`,
    `    source: ${source}`,
    ...(diagnostic.confidence ? [`    confidence: ${diagnostic.confidence}`] : []),
    ...(diagnostic.evidence ?? []).map((item) => `    evidence: ${item.kind}: ${item.summary}`),
  ].join("\n");
}

/** `path:line:column` relative to `root`, or the path alone for an unlocated Diagnostic. */
export function diagnosticLocation(root: string, diagnostic: Diagnostic): string {
  const path = relative(root, diagnostic.file) || ".";
  return diagnostic.range ? `${path}:${diagnostic.range.line}:${diagnostic.range.column}` : path;
}

function isLocated(root: string, diagnostic: Diagnostic): boolean {
  return Boolean(diagnostic.range) || relative(root, diagnostic.file) !== "";
}

/** The location of a Diagnostic, or what it is about when it has no file of its own. */
function diagnosticLabel(root: string, diagnostic: Diagnostic): string {
  return isLocated(root, diagnostic) || !diagnostic.subject
    ? diagnosticLocation(root, diagnostic)
    : diagnostic.subject;
}

function reportBudget(context: DoctorReportContext): number {
  return context.runOptions?.maxChars ?? DEFAULT_REPORT_BUDGET;
}

function groupDiagnostics(result: DoctorRunResult): ReportGroup[] {
  const groups = new Map<string, ReportGroup>();
  for (const diagnostic of result.diagnostics) {
    const key = `${diagnostic.severity}\0${diagnostic.code}\0${diagnostic.confidence ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        severity: diagnostic.severity,
        code: diagnostic.code,
        ruleId: diagnostic.ruleId,
        title:
          result.ruleTitles?.[diagnostic.ruleId] ??
          diagnosticMetadataByCode.get(diagnostic.code)?.title ??
          diagnostic.ruleId,
        confidence: diagnostic.confidence,
        docs: diagnostic.docs,
        diagnostics: [],
        evidence: [],
      };
      groups.set(key, group);
    }
    group.diagnostics.push(diagnostic);
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  for (const group of ordered) {
    const fixes = new Set(group.diagnostics.map((diagnostic) => diagnostic.diagnostic.fix));
    const [fix] = fixes;
    if (fixes.size === 1 && fix) group.fix = fix;
    const evidence = new Map<string, { item: DiagnosticEvidence; count: number }>();
    for (const diagnostic of group.diagnostics) {
      const seen = new Set<string>();
      for (const item of diagnostic.evidence ?? []) {
        const key = `${item.kind}\0${item.summary}\0${item.file ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = evidence.get(key);
        if (entry) entry.count++;
        else evidence.set(key, { item, count: 1 });
      }
    }
    // Evidence of a single Diagnostic in a larger group belongs to that Diagnostic's detail.
    group.evidence = [...evidence.values()].filter(
      (entry) => entry.count > 1 || entry.count === group.diagnostics.length,
    );
  }
  return ordered;
}

/** Diagnostic Codes with their counts, in report order. */
function codeIndex(groups: ReportGroup[]): Record<string, number> {
  const codes: Record<string, number> = {};
  for (const group of groups)
    codes[group.code] = (codes[group.code] ?? 0) + group.diagnostics.length;
  return codes;
}

function groupHidden(group: ReportGroup, shown: GroupShown): boolean {
  return shown.rows < group.diagnostics.length || !shown.detail;
}

/**
 * Renders a text or agent report within `maxChars`: the plan picks the units that fit, and the
 * last unit is dropped while the rendered report is still over the Report Budget.
 */
function progressiveReport(
  result: DoctorRunResult,
  context: DoctorReportContext,
  format: "text" | "agent",
  maxChars: number,
  withHints: boolean,
): ProgressiveOutcome {
  const groups = groupDiagnostics(result);
  const layout =
    format === "agent"
      ? agentLayout(result, context, groups, maxChars)
      : textLayout(result, context, groups, maxChars);
  let units = planReportBudget(layout.fixed, layout.groups, maxChars);
  const reruns = new Map<string, ProgressiveOutcome>();
  for (;;) {
    const shown = shownGroups(layout.groups, units);
    const hints = groups.map((group, index) => {
      const state = shown[index]!;
      if (!state.header || !groupHidden(group, state)) return undefined;
      const full = ["--rules", group.ruleId, "--full"];
      if (!withHints) return full;
      return ruleRerunShowsMore(result, context, format, maxChars, group, state, reruns)
        ? ["--rules", group.ruleId]
        : full;
    });
    const report = layout.render(shown, hints);
    if (report.length <= maxChars || !units.length) return { report, groups, shown };
    units = units.slice(0, -1);
  }
}

/** Whether rerunning only the group's Rule, under the budget that command gets, shows more of it. */
function ruleRerunShowsMore(
  result: DoctorRunResult,
  context: DoctorReportContext,
  format: "text" | "agent",
  maxChars: number,
  group: ReportGroup,
  state: GroupShown,
  reruns: Map<string, ProgressiveOutcome>,
): boolean {
  let rerun = reruns.get(group.ruleId);
  if (!rerun) {
    const diagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === group.ruleId,
    );
    // The CLI hint never repeats --max-chars; plugin options keep the configured maxChars.
    const budget = context.surface === "plugin" ? maxChars : DEFAULT_REPORT_BUDGET;
    rerun = progressiveReport(
      { ...result, diagnostics, summary: scoreDiagnostics(diagnostics, {}).summary },
      { ...context, runOptions: { ...context.runOptions, rules: group.ruleId } },
      format,
      budget,
      false,
    );
    reruns.set(group.ruleId, rerun);
  }
  const index = rerun.groups.findIndex((item) => item.key === group.key);
  const other = rerun.shown[index];
  if (!other?.header) return false;
  return other.rows > state.rows || (other.detail && !state.detail);
}

function textLayout(
  result: DoctorRunResult,
  context: DoctorReportContext,
  groups: ReportGroup[],
  maxChars: number,
): ProgressiveLayout {
  const cost = (lines: string[]) => lines.reduce((total, line) => total + line.length + 1, 0);
  const head = textHead(result, groups);
  const tail = textTail(result);
  const total = result.diagnostics.length;
  const codes = new Set(groups.map((group) => group.code)).size;
  const plugin = context.surface === "plugin";
  const commandRoot = context.cwd ? relative(context.cwd, result.root) || "." : ".";
  const command = (options: Omit<RunCommand, "root" | "format">) =>
    runArguments(result, context, { ...options, root: commandRoot, format: context.formatFlag })
      .map(shellArgument)
      .join(" ");
  const commands = plugin
    ? undefined
    : { more: command({ rules: null }), full: command({ full: true }) };
  const plural = (count: number, noun: string) =>
    `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
  const footer = (hidden: BudgetHidden, hiddenCodes: number): string[] => {
    if (!hasHidden(hidden)) return [];
    const limit = `(limit ${plural(maxChars, "character")}).`;
    const first =
      hidden.rows || hidden.groups
        ? `Hidden: ${hidden.rows.toLocaleString("en-US")} of ${plural(total, "Diagnostic")}${hiddenCodes ? `, ${hiddenCodes} of ${plural(codes, "Diagnostic Code")}` : ""} ${limit}`
        : `Detail hidden for ${plural(hidden.detail, "Diagnostic")} ${limit}`;
    return [
      "",
      first,
      ...(commands
        ? [`One group: ${commands.more} plus its "more:" flags`, `Everything: ${commands.full}`]
        : ["More: set rules or maxChars: Infinity in the Doctor plugin options"]),
    ];
  };
  const worstFooter = Math.max(
    cost(footer({ groups: groups.length, rows: total, detail: total }, codes)),
    cost(footer({ groups: 0, rows: 0, detail: total }, 0)),
  );
  const hintLine = (group: ReportGroup, hint: GroupHint) =>
    plugin
      ? `  more: rules: ${JSON.stringify(group.ruleId)}${hint.includes("--full") ? ", maxChars: Infinity" : ""}`
      : `  more: ${hint.map(shellArgument).join(" ")}`;
  const parts = groups.map((group, index) => {
    const tierStart = index === 0 || groups[index - 1]!.severity !== group.severity;
    const tierCount = groups
      .filter((item) => item.severity === group.severity)
      .reduce((sum, item) => sum + item.diagnostics.length, 0);
    const heading = tierStart
      ? ["", pc.bold(`${labelSeverity(group.severity)} (${tierCount})`)]
      : [];
    const count = group.diagnostics.length;
    const title = [
      "",
      `${group.code}  ${group.title} · ${plural(count, "Diagnostic")}${group.confidence ? ` · ${group.confidence}` : ""}`,
    ];
    const labels = group.diagnostics.map((diagnostic) => diagnosticLabel(result.root, diagnostic));
    const width = Math.min(48, Math.max(...labels.map((label) => label.length)));
    const rows = group.diagnostics.map((diagnostic, row) => {
      const safety = diagnostic.fix ? ` · ${fixSafetyLabel(diagnostic.fix.kind)}` : "";
      const text = (diagnostic.brief ?? diagnostic.why).replaceAll(
        "\n",
        `\n${" ".repeat(width + 4)}`,
      );
      return `  ${labels[row]!.padEnd(width)}  ${text}${safety}`;
    });
    const trailer = (hiddenRows: number, hint: GroupHint | undefined) => [
      ...(hiddenRows ? [`  (${plural(hiddenRows, "more row")})`] : []),
      ...(group.fix ? [`  fix: ${group.fix.replaceAll("\n", "\n       ")}`] : []),
      ...group.evidence.map(
        (entry) =>
          `  evidence: ${entry.item.kind}: ${entry.item.summary}${entry.count < count ? ` (${entry.count} of ${count})` : ""}`,
      ),
      `  rule: ${group.ruleId}${group.docs ? ` · see: ${group.docs}` : ""}`,
      ...(hint ? [hintLine(group, hint)] : []),
    ];
    const details = group.diagnostics.map((diagnostic, row) =>
      textDiagnosticBlock(labels[row]!, diagnostic),
    );
    const worstTrailer = trailer(count, ["--rules", group.ruleId, "--full"]);
    const rowCosts = rows.map((row) => row.length + 1);
    return {
      heading,
      title,
      rows,
      details,
      trailer,
      budget: {
        tier: SEVERITIES.indexOf(group.severity),
        header: cost([...heading, ...title, ...worstTrailer]),
        rows: rowCosts,
        detail: cost(details) - rowCosts.reduce((sum, row) => sum + row, 0) - cost(worstTrailer),
      },
    };
  });
  const budgetGroups = parts.map((part) => part.budget);
  return {
    fixed: cost(head) + cost(tail) + worstFooter,
    groups: budgetGroups,
    render(shown, hints) {
      const body = parts.flatMap((part, index) => {
        const state = shown[index]!;
        if (!state.header) return [];
        if (state.detail) return [...part.heading, ...part.title, ...part.details];
        return [
          ...part.heading,
          ...part.title,
          ...part.rows.slice(0, state.rows),
          ...part.trailer(part.rows.length - state.rows, hints[index]),
        ];
      });
      const hidden = hiddenCounts(budgetGroups, shown);
      const hiddenCodes = [...new Set(groups.map((group) => group.code))].filter((code) =>
        groups.every((group, index) => group.code !== code || !shown[index]!.header),
      ).length;
      return `${[...head, ...body, ...tail, ...footer(hidden, hiddenCodes)].join("\n")}\n`;
    },
  };
}

function textHead(result: DoctorRunResult, groups: ReportGroup[]): string[] {
  const lines: string[] = [];
  const status = reportStatus(result);
  lines.push(`Detected: ${frameworkLabel(result)}`);
  lines.push(`Project: ${result.root}`);
  if (status === "incomplete") {
    lines.push("Status: incomplete, required project evidence is missing");
  }
  for (const gap of result.project.evidenceGaps ?? []) {
    lines.push(`Evidence missing: ${gap.message} ${gap.files.join(", ")}`);
  }
  for (const used of result.project.evidenceUsed ?? [])
    lines.push(`Evidence used: ${used.message}`);
  for (const edge of result.project.runtimeGraph?.edges ?? []) {
    const runtime = result.project.runtimeGraph?.packages[edge.to];
    const identity =
      runtime?.state === "resolved"
        ? `${runtime.name}@${runtime.version}`
        : `unknown${runtime?.reason ? ` (${runtime.reason})` : ""}`;
    lines.push(`Runtime: ${edge.from} -> ${edge.to} ${identity}`);
  }
  if (result.project.nuxtCompatibility) {
    lines.push(
      `Nuxt compatibility: ${result.project.nuxtCompatibility.state === "resolved" ? result.project.nuxtCompatibility.version : "unknown"} (${result.project.nuxtCompatibility.provenance})`,
    );
  }
  if (result.project.nuxt?.manifest) {
    const evidence = result.project.nuxt.manifest.evidence;
    lines.push(
      `Evidence used: manifest ${result.project.nuxt.manifest.hasManifest ? "present" : "missing"}, route graph ${evidence?.routeGraph ? "present" : "missing"}, build manifest ${evidence?.buildManifest ? "present" : "missing"}, ${evidence?.prerenderRoutes ?? 0} prerender routes, ${evidence?.serverRoutes ?? 0} server routes`,
    );
  }
  const unselected = result.rulePacks?.filter((pack) => !pack.selected && pack.activatedBy.length);
  if (unselected?.length) {
    lines.push(
      `Rule Packs not selected by extends: ${unselected.map((pack) => pack.name).join(", ")} (add "auto" to extends to select their recommended presets)`,
    );
  }
  const confidence = confidenceMix(result);
  lines.push(
    `Confidence mix: ${confidence.proven} proven, ${confidence.probable} probable, ${confidence.sourceOnly} source-only${confidence.undeclared ? `, ${confidence.undeclared} undeclared` : ""}`,
  );
  if (result.fixes && (result.fixes.edits || result.fixes.skipped)) {
    lines.push(
      `Fixes applied: ${result.fixes.edits} edits in ${result.fixes.files} files${result.fixes.skipped ? `, ${result.fixes.skipped} skipped` : ""}`,
    );
  }
  lines.push("");
  lines.push("Summary");
  lines.push(
    `  ${result.summary.blocker} blockers, ${result.summary.error} errors, ${result.summary.warn} warnings, ${result.summary.info} info`,
  );
  lines.push(`  ${result.summary.fixable} safe fixes available`);
  const codes = Object.entries(codeIndex(groups));
  if (codes.length)
    lines.push(`  Codes: ${codes.map(([code, count]) => `${code} ×${count}`).join(", ")}`);
  return lines;
}

function textTail(result: DoctorRunResult): string[] {
  const lines: string[] = [];
  if (result.timings) {
    lines.push("");
    lines.push("Timings");
    for (const [name, ms] of Object.entries(result.timings)) lines.push(`  ${name}: ${ms}ms`);
  }
  if (result.ruleTimings?.length) {
    lines.push("");
    lines.push("Slowest rules");
    for (const timing of result.ruleTimings.slice(0, 10))
      lines.push(`  ${timing.rule}: ${timing.ms}ms`);
  }
  if (result.graph?.files) {
    lines.push("");
    lines.push("Graph");
    lines.push(
      `  ${result.graph.files} files, ${result.graph.importEdges} imports, ${result.graph.exportEdges} exports, ${result.graph.virtualRoots} roots, ${result.graph.cycles} cycles`,
    );
  }
  return lines;
}

function fixSafetyLabel(kind: FixSafety): string {
  return kind === "safe" || kind === "unsafe" ? `${kind} fix` : kind.replace("-", " ");
}

function confidenceMix(result: DoctorRunResult) {
  const mix = { proven: 0, probable: 0, sourceOnly: 0, undeclared: 0 };
  for (const diagnostic of result.diagnostics) {
    const confidence = diagnostic.confidence;
    if (!confidence) mix.undeclared++;
    else if (isEvidenceBacked(confidence)) mix.proven++;
    else if (confidence === "heuristic-high") mix.probable++;
    else mix.sourceOnly++;
  }
  return mix;
}

function isEvidenceBacked(confidence: Confidence) {
  return (
    confidence === "proven" ||
    confidence === "type-backed" ||
    confidence === "manifest-backed" ||
    confidence === "runtime-backed"
  );
}

export function createJsonReport(result: DoctorRunResult): string {
  return `${JSON.stringify(
    {
      version: result.version,
      reportVersion: result.reportVersion ?? 4,
      fingerprintScheme: FINGERPRINT_SCHEME,
      status: reportStatus(result),
      framework: result.framework,
      root: result.root,
      scope: result.scope,
      summary: result.summary,
      diagnostics: result.diagnostics.map((diagnostic) => serializeDiagnostic(result, diagnostic)),
      suppressedDiagnostics: result.suppressedDiagnostics?.map((diagnostic) =>
        serializeDiagnostic(result, diagnostic),
      ),
      fixes: result.fixes,
      score: result.score,
      categoryScores: result.categoryScores,
      timings: result.timings,
      phases: result.phases,
      ruleTimings: result.ruleTimings,
      graph: result.graph,
      extends: result.extends,
      rulePacks: result.rulePacks,
      workspacePackages: result.workspacePackages,
      evidenceGaps: result.project.evidenceGaps,
      evidenceUsed: result.project.evidenceUsed,
      runtimeGraph: result.project.runtimeGraph,
      nuxtCompatibility: result.project.nuxtCompatibility,
    },
    null,
    2,
  )}\n`;
}

export function createAgentReport(
  result: DoctorRunResult,
  context: DoctorReportContext = {},
): string {
  return progressiveReport(result, context, "agent", reportBudget(context), true).report;
}

function agentLayout(
  result: DoctorRunResult,
  context: DoctorReportContext,
  groups: ReportGroup[],
  maxChars: number,
): ProgressiveLayout {
  const status = reportStatus(result);
  const commandArgs = {
    explain: [
      "vite-doctor",
      "explain",
      "<code>",
      "--framework",
      agentFramework(result, context),
      ...(context.configFile ? ["--config", context.configFile] : []),
      ...(context.runOptions?.hostExtensions ? ["--host-extensions"] : []),
      "--format",
      "agent",
    ],
    verify: runArguments(result, context, { rules: "<rule>", format: "agent" }),
    rerun: runArguments(result, context, { format: "agent" }),
    more: runArguments(result, context, { rules: null, format: "agent" }),
    full: runArguments(result, context, { full: true, format: "agent" }),
  };
  const codes = codeIndex(groups);
  const total = result.diagnostics.length;
  const serialize = (budget: object | undefined, items: object[]) =>
    `${JSON.stringify({
      schema: "vite-doctor.agent/v3",
      status,
      project: {
        cwd: result.root,
        framework: result.framework,
        workspacePackages: result.workspacePackages,
      },
      rulePacks: result.rulePacks,
      scope: result.scope,
      summary: result.summary,
      codes,
      budget,
      groups: items,
      fixes: result.fixes,
      evidenceGaps: result.project.evidenceGaps,
      evidenceUsed: result.project.evidenceUsed,
      commands: Object.fromEntries(
        Object.entries(commandArgs).map(([name, args]) => [
          name,
          args.map(shellArgument).join(" "),
        ]),
      ),
      commandArgs,
      next:
        status === "clean"
          ? { action: "none" }
          : status === "incomplete"
            ? {
                action: "restore-evidence",
                instruction:
                  result.project.evidenceGaps?.map((gap) => gap.message).join(" ") ||
                  "Install project dependencies and run Doctor from the target package before relying on version-specific results.",
              }
            : {
                action: "remediate",
                instruction: budget
                  ? "Apply the smallest remediation that resolves each owned diagnostic, run its focused verification, then rerun Doctor. To see what the Report Budget hid, append a group's more items to commandArgs.more."
                  : "Apply the smallest remediation that resolves each owned diagnostic, run its focused verification, then rerun Doctor.",
              },
    })}\n`;
  const budgetField = (hidden: BudgetHidden) => ({ maxChars, hidden });
  const parts = groups.map((group) => {
    const count = group.diagnostics.length;
    const head = (hint: GroupHint | undefined, rowsHidden: number) => ({
      code: group.code,
      rule: group.ruleId,
      title: group.title,
      severity: group.severity,
      confidence: group.confidence,
      count,
      docs: group.docs,
      remediation: group.fix,
      evidence: group.evidence.length
        ? group.evidence.map((entry) => ({
            ...serializeEvidenceItem(result, entry.item),
            ...(entry.count < count ? { diagnostics: entry.count } : {}),
          }))
        : undefined,
      more: hint,
      rowsHidden: rowsHidden || undefined,
    });
    const rows = group.diagnostics.map((diagnostic) => agentRow(result, diagnostic));
    const details = group.diagnostics.map((diagnostic) => agentDetail(result, diagnostic));
    const json = (value: unknown) => JSON.stringify(value).length + 1;
    const rowCosts = rows.map(json);
    return {
      head,
      rows,
      details,
      budget: {
        tier: SEVERITIES.indexOf(group.severity),
        header: json({ ...head(["--rules", group.ruleId, "--full"], count), diagnostics: [] }),
        rows: rowCosts,
        detail:
          details.reduce((sum: number, detail) => sum + json(detail), 0) -
          rowCosts.reduce((sum, row) => sum + row, 0),
      },
    };
  });
  const budgetGroups = parts.map((part) => part.budget);
  return {
    fixed: serialize(budgetField({ groups: groups.length, rows: total, detail: total }), []).length,
    groups: budgetGroups,
    render(shown, hints) {
      const items = parts.flatMap((part, index) => {
        const state = shown[index]!;
        if (!state.header) return [];
        return [
          {
            ...part.head(hints[index], part.rows.length - state.rows),
            diagnostics: state.detail ? part.details : part.rows.slice(0, state.rows),
          },
        ];
      });
      const hidden = hiddenCounts(budgetGroups, shown);
      return serialize(hasHidden(hidden) ? budgetField(hidden) : undefined, items);
    },
  };
}

function agentLocation(result: DoctorRunResult, diagnostic: Diagnostic) {
  return {
    path: relative(result.root, diagnostic.file) || ".",
    line: diagnostic.range?.line,
    column: diagnostic.range?.column,
  };
}

/** A Diagnostic's row: where it is or what it is about, and the Rule's brief or its message. */
function agentRow(result: DoctorRunResult, diagnostic: Diagnostic) {
  return {
    location:
      isLocated(result.root, diagnostic) || !diagnostic.subject
        ? agentLocation(result, diagnostic)
        : undefined,
    subject: diagnostic.subject,
    ...(diagnostic.brief ? { brief: diagnostic.brief } : { message: diagnostic.why }),
    fixSafety: diagnostic.fix?.kind,
  };
}

function agentDetail(result: DoctorRunResult, diagnostic: Diagnostic) {
  return {
    fingerprint: diagnostic.fingerprint,
    location: agentLocation(result, diagnostic),
    subject: diagnostic.subject,
    brief: diagnostic.brief,
    message: diagnostic.why,
    fixSafety: diagnostic.fix?.kind,
    remediation: diagnostic.diagnostic.fix,
    evidence: serializeEvidence(result, diagnostic),
    data: diagnostic.data,
    editPlan: diagnostic.fix,
    related: diagnostic.related?.map((item) => ({
      path: relative(result.root, item.file),
      line: item.range?.line,
      column: item.range?.column,
      message: item.message,
    })),
  };
}

export function createSarifReport(result: DoctorRunResult): string {
  const status = reportStatus(result);
  const gaps = result.project.evidenceGaps;
  const ruleId = (diagnostic: Diagnostic) => `${diagnostic.ruleId}:${diagnostic.code}`;
  const rules = new Map<string, Diagnostic>();
  for (const diagnostic of result.diagnostics) rules.set(ruleId(diagnostic), diagnostic);
  return `${JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [
        {
          properties: { status },
          invocations: [
            {
              executionSuccessful: status !== "incomplete",
              toolExecutionNotifications:
                status === "incomplete"
                  ? gaps?.length
                    ? gaps.map((gap) => ({
                        level: "error",
                        message: { text: gap.message },
                        properties: { source: gap.source, files: gap.files },
                      }))
                    : [
                        {
                          level: "error",
                          message: {
                            text: "Install project dependencies and run Doctor from the target package before relying on version-specific results.",
                          },
                        },
                      ]
                  : undefined,
            },
          ],
          columnKind: "utf16CodeUnits",
          tool: {
            driver: {
              name: "Vite Doctor",
              semanticVersion: result.version,
              rules: [...rules.values()].map((diagnostic) => ({
                id: ruleId(diagnostic),
                name: diagnostic.code,
                shortDescription: { text: diagnostic.code },
                helpUri: diagnostic.docs,
                properties: {
                  diagnosticCode: diagnostic.code,
                  category: diagnostic.category,
                  confidence: diagnostic.confidence,
                  analysisPhase: diagnostic.analysisPhase,
                },
              })),
            },
          },
          results: result.diagnostics.map((diagnostic) => ({
            ruleId: ruleId(diagnostic),
            rule: { id: ruleId(diagnostic) },
            level: sarifLevel(diagnostic.severity),
            message: { text: diagnostic.why },
            partialFingerprints: {
              "vite-doctor/v1": diagnostic.fingerprint,
            },
            properties: {
              confidence: diagnostic.confidence,
              diagnosticCode: diagnostic.code,
              docs: diagnostic.docs,
              evidenceKinds: diagnostic.evidence?.length
                ? diagnostic.evidence.map((item) => item.kind)
                : undefined,
              analysisPhase: diagnostic.analysisPhase,
              data: diagnostic.data,
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: sarifArtifactUri(result.root, diagnostic.file) },
                  region: diagnostic.range
                    ? {
                        startLine: diagnostic.range.line,
                        startColumn: diagnostic.range.column,
                      }
                    : undefined,
                },
              },
            ],
            relatedLocations: diagnostic.related?.map((item) => ({
              physicalLocation: {
                artifactLocation: { uri: sarifArtifactUri(result.root, item.file) },
                region: item.range
                  ? { startLine: item.range.line, startColumn: item.range.column }
                  : undefined,
              },
              message: { text: item.message },
            })),
          })),
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export function createReport(
  result: DoctorRunResult,
  format: DoctorReportFormat = "text",
  context: DoctorReportContext = {},
): string {
  if (format === "json") return createJsonReport(result);
  if (format === "sarif") return createSarifReport(result);
  if (format === "agent") return createAgentReport(result, context);
  return `${createTextReport(result, context)}\n`;
}

function sarifArtifactUri(root: string, file: string): string {
  return relative(root, file).split("/").map(encodeURIComponent).join("/");
}

export function createRulesReport(
  packs: RulePack[],
  format: Exclude<DoctorReportFormat, "sarif"> = "text",
): string {
  const rules = packs.flatMap((pack) =>
    pack.rules.map((rule) => ({
      pack: pack.name,
      version: pack.version,
      diagnosticCodes: rule.meta.diagnosticCodes ?? codeListForRule(pack, rule.meta.id),
      ...rule.meta,
    })),
  );
  if (format === "json") return `${JSON.stringify({ rules }, null, 2)}\n`;
  if (format === "agent") {
    return `${JSON.stringify({ schema: "vite-doctor.rules/v1", status: "ready", rules })}\n`;
  }
  const lines: string[] = [];
  for (const pack of packs) {
    lines.push(pack.name);
    for (const rule of pack.rules) lines.push(`  ${rule.meta.id} ${rule.meta.severity}`);
  }
  return `${lines.join("\n")}\n`;
}

export function explainRule(
  packs: RulePack[],
  ruleId: string,
  format: Exclude<DoctorReportFormat, "sarif"> = "text",
): string {
  const match = packs
    .flatMap((pack) => pack.rules.map((rule) => ({ pack, rule })))
    .find(
      (item) =>
        item.rule.meta.id === ruleId ||
        item.rule.meta.diagnosticCodes?.includes(ruleId) ||
        codeListForRule(item.pack, item.rule.meta.id).includes(ruleId),
    );
  if (!match) {
    const metadata = diagnosticMetadataByCode.get(ruleId) ?? diagnosticMetadataByRuleId.get(ruleId);
    if (!metadata) return "";
    const diagnosticCodes = [metadata.code];
    const meta = {
      id: metadata.ruleId,
      title: metadata.title,
      description: metadata.description,
      why: metadata.why,
      recommendedReplacement: metadata.fix,
      category: metadata.category,
      severity: metadata.severity,
      fixable: "no" as const,
      docsUrl: diagnosticReferenceUrl(metadata.code),
      diagnosticCodes,
      analysis: metadata.analysis,
    };
    const payload = {
      ...meta,
      diagnosticCodes,
      diagnostics: diagnosticCodes.map((code) => ({ code, docs: diagnosticReferenceUrl(code) })),
    };
    if (format === "json") return `${JSON.stringify(payload, null, 2)}\n`;
    if (format === "agent") {
      return `${JSON.stringify({ schema: "vite-doctor.explain/v1", status: "ready", ...payload })}\n`;
    }
    return (
      [
        `${meta.id} (${meta.severity})`,
        meta.title,
        meta.description,
        `Why: ${meta.why}`,
        `Prefer: ${meta.recommendedReplacement}`,
        `Diagnostics: ${diagnosticCodes.join(", ")}`,
        ...diagnosticCodes.map((code) => `Docs: ${diagnosticReferenceUrl(code)}`),
      ].join("\n") + "\n"
    );
  }
  const diagnosticCodes =
    match.rule.meta.diagnosticCodes ?? codeListForRule(match.pack, match.rule.meta.id);
  const documentedCodes =
    (allDiagnosticCodeListsByRuleId as Record<string, readonly string[]>)[match.rule.meta.id] ?? [];
  const packDocs: Readonly<Record<string, string | undefined>> =
    match.pack.diagnostics?.docsByCode ?? {};
  const diagnostics = diagnosticCodes.map((code) => ({
    code,
    docs:
      code in packDocs
        ? packDocs[code]
        : documentedCodes.includes(code)
          ? diagnosticReferenceUrl(code)
          : undefined,
  }));
  const payload = {
    pack: match.pack.name,
    diagnosticCodes,
    diagnostics,
    ...match.rule.meta,
  };
  if (format === "json") return `${JSON.stringify(payload, null, 2)}\n`;
  if (format === "agent") {
    return `${JSON.stringify({ schema: "vite-doctor.explain/v1", status: "ready", ...payload })}\n`;
  }
  const meta = match.rule.meta;
  return (
    [
      `${meta.id} (${meta.severity})`,
      meta.title,
      meta.description,
      meta.why ? `Why: ${meta.why}` : undefined,
      meta.recommendedReplacement ? `Prefer: ${meta.recommendedReplacement}` : undefined,
      `Diagnostics: ${diagnosticCodes.join(", ")}`,
      ...diagnostics.flatMap((diagnostic) => (diagnostic.docs ? [`Docs: ${diagnostic.docs}`] : [])),
      meta.docsUrl ? `Reference: ${meta.docsUrl}` : undefined,
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

export function reportStatus(result: DoctorRunResult): "clean" | "findings" | "incomplete" {
  if (result.project.evidenceGaps?.length) return "incomplete";
  const expectedRuntimes =
    result.project.framework === "nuxt"
      ? (["nuxt", "nitro", "h3"] as const)
      : result.project.framework === "nitro"
        ? (["nitro", "h3"] as const)
        : result.project.framework === "vue"
          ? (["vue"] as const)
          : [];
  const unresolvedRuntime = expectedRuntimes.some(
    (runtime) => result.project.runtimeGraph?.packages[runtime]?.state === "unknown",
  );
  if (unresolvedRuntime || result.project.nuxtCompatibility?.state === "unknown") {
    return "incomplete";
  }
  return result.diagnostics.length > 0 ? "findings" : "clean";
}

function serializeDiagnostic(result: DoctorRunResult, diagnostic: Diagnostic) {
  return {
    fingerprint: diagnostic.fingerprint,
    code: diagnostic.code,
    rule: diagnostic.ruleId,
    severity: diagnostic.severity,
    confidence: diagnostic.confidence,
    category: diagnostic.category,
    message: diagnostic.why,
    remediation: diagnostic.diagnostic.fix,
    docs: diagnostic.docs,
    subject: diagnostic.subject,
    brief: diagnostic.brief,
    location: {
      path: relative(result.root, diagnostic.file),
      ...(diagnostic.range
        ? {
            line: diagnostic.range.line,
            column: diagnostic.range.column,
            start: diagnostic.range.start,
            end: diagnostic.range.end,
          }
        : {}),
    },
    evidence: serializeEvidence(result, diagnostic),
    data: diagnostic.data,
    editPlan: diagnostic.fix,
    related: diagnostic.related?.map((item) => ({
      path: relative(result.root, item.file),
      range: item.range,
      message: item.message,
    })),
    suppression: diagnostic.suppressed
      ? { suppressed: true, reason: diagnostic.suppressionReason }
      : undefined,
    analysis: diagnostic.analysisPhase,
  };
}

function serializeEvidence(result: DoctorRunResult, diagnostic: Diagnostic) {
  if (!diagnostic.evidence?.length) return undefined;
  return diagnostic.evidence.map((item) => serializeEvidenceItem(result, item));
}

function serializeEvidenceItem(result: DoctorRunResult, item: DiagnosticEvidence) {
  return {
    kind: item.kind,
    summary: item.summary,
    path: item.file ? relative(result.root, item.file) : undefined,
    range: item.range,
    relatedId: item.relatedId,
  };
}

interface RunCommand {
  /** Project path; agent commands keep `.` and the `project.cwd` contract. */
  root?: string;
  /** Rule selectors; `undefined` repeats the caller's, `null` drops them. */
  rules?: string | null;
  full?: boolean;
  format?: DoctorReportFormat;
}

/**
 * The `vite-doctor` command that reruns this Doctor Run. It never repeats flags that change files
 * or the Report Budget (`--fix`, `--unsafe-fix`, `--update-baseline`, `--watch`, `--max-chars`).
 */
function runArguments(
  result: DoctorRunResult,
  context: DoctorReportContext,
  command: RunCommand,
): string[] {
  const args = ["vite-doctor", command.root ?? ".", "--framework", agentFramework(result, context)];
  if (result.scope.mode === "changed") {
    if (result.scope.base) args.push("--since", result.scope.base);
    else args.push("--changed");
  }
  const options = context.runOptions;
  if (result.extends === "strict") args.push("--strict");
  else if (options?.extends === "auto") args.push("--extends", "auto");
  else if (Array.isArray(result.extends) && result.extends.length)
    args.push("--extends", result.extends.join(","));
  if (context.configFile) args.push("--config", context.configFile);
  if (options?.hostExtensions) args.push("--host-extensions");
  const rules = command.rules === undefined ? options?.rules : command.rules;
  if (rules) args.push("--rules", rules);
  for (const [flag, value] of [
    ["--severity", options?.severity],
    ["--analyses", options?.analyses],
    ["--baseline", options?.baseline],
    ["--max-warnings", options?.maxWarnings],
  ] as const) {
    if (value !== undefined) args.push(flag, String(value));
  }
  for (let index = 0; index < (options?.mcp?.length ?? 0); index++)
    args.push("--mcp-url", "<mcp-url>");
  // Header values carry tokens, so commands name the header and leave its value to the agent.
  for (const name of Object.keys(options?.mcp?.[0]?.headers ?? {}))
    if (isMcpHeaderName(name)) args.push("--mcp-header", `${name}: <value>`);
  if (options?.newOnly) args.push("--new-only");
  if (options?.profile) args.push("--profile");
  if (options?.cache !== undefined) args.push(options.cache ? "--cache" : "--no-cache");
  if (command.full) args.push("--full");
  if (command.format) args.push("--format", command.format);
  return args;
}

// Workspace runs derive Rule Packs from every workspace package, which pinning the resolved
// framework would replace with that framework's packs alone.
function agentFramework(result: DoctorRunResult, context: DoctorReportContext): string {
  const requested = context.runOptions?.framework;
  if (requested && requested !== "auto") return requested;
  return (result.workspacePackages?.length ?? 0) > 1 ? "auto" : result.framework;
}

function diagnosticReferenceUrl(code: string) {
  return `${DOCTOR_DIAGNOSTICS_DOCS_BASE}/${code}`;
}

function frameworkLabel(result: DoctorRunResult): string {
  const packages = result.workspacePackages ?? [];
  // Run runtime versions can belong to a nested Nuxt owner.
  const showVersions = packages.length <= 1;
  const label =
    result.framework === "nuxt"
      ? showVersions
        ? `Nuxt ${result.project.nuxtVersion ?? "4"} + Vue ${result.project.vueVersion}`
        : "Nuxt + Vue"
      : result.framework === "vite"
        ? "Vite"
        : result.framework === "nitro"
          ? "Nitro"
          : showVersions
            ? `Vue ${result.project.vueVersion}`
            : "Vue";
  if (packages.length <= 1) return label;
  const counts = new Map<string, number>();
  for (const item of packages) counts.set(item.framework, (counts.get(item.framework) ?? 0) + 1);
  return `${label} at the root; workspace packages: ${[...counts].map(([framework, count]) => `${count} ${framework}`).join(", ")}`;
}

function sarifLevel(severity: Diagnostic["severity"]) {
  if (severity === "blocker" || severity === "error") return "error";
  if (severity === "warn") return "warning";
  return "note";
}

function labelSeverity(severity: string): string {
  return severity === "blocker"
    ? "Blockers"
    : severity === "error"
      ? "Errors"
      : severity === "warn"
        ? "Warnings"
        : "Info";
}

function codeListForRule(pack: RulePack, ruleId: string): string[] {
  const packCodes: Readonly<Record<string, readonly string[] | undefined>> | undefined =
    pack.diagnostics?.codesByRuleIdAll;
  if (packCodes?.[ruleId]) return [...packCodes[ruleId]];
  const code = codeForRuleId(allDiagnosticCodesByRuleId, ruleId);
  return code ? [code] : [];
}

function indent(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
