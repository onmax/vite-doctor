import { isAbsolute, relative } from "pathe";
import { isMcpHeaderName, parseMcpEndpoint } from "@loadsheet/mcp";
import pc from "picocolors";
import { formatDiagnostic } from "nostics";
import type {
  Confidence,
  Diagnostic,
  DiagnosticEvidence,
  DiagnosticOrigin,
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
import { REDACTED } from "./internal/evidence-sources.js";
import { mcpServerLabels } from "../mcp/evidence.js";
import { unresolvedRuntimeInventory } from "./internal/runtime-packages.js";
import { defaultReportBudget, type ReportReader } from "./internal/agent-runtime.js";
import { scoreDiagnostics } from "./internal/scoring.js";
import { reportGroupKey, reportOrder, SEVERITIES } from "./internal/report-order.js";
import {
  type BudgetGroup,
  type BudgetHidden,
  type GroupShown,
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
  /** Who reads the report, which sets the Report Budget when `runOptions.maxChars` is unset. */
  reader?: ReportReader;
}

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

type GroupHint = { rules: string; full: boolean } | "full";

const FULL_PLUGIN_OPTIONS = { maxChars: "Infinity" } as const;

function pluginHint(hint: GroupHint) {
  if (hint === "full") return FULL_PLUGIN_OPTIONS;
  return { rules: hint.rules, ...(hint.full ? FULL_PLUGIN_OPTIONS : {}) };
}

function cliHint(hint: Exclude<GroupHint, "full">) {
  return ["--rules", hint.rules, ...(hint.full ? ["--full"] : [])];
}

interface ProgressiveLayout {
  /** Head, tail and the longest footer, which a plan can never cut. */
  fixed: number;
  /** Exact complete rendering size, or Infinity once it cannot fit. */
  completeSize: number;
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
  return progressiveReport(result, context, "text", reportBudget(context, "text"), true, "").report;
}

/** One Diagnostic as the text report renders it, indented for a severity section. */
export function formatTextDiagnostic(root: string, diagnostic: Diagnostic): string {
  return textDiagnosticBlock(diagnosticLocation(root, diagnostic), diagnostic);
}

/** `shared` names evidence the group already printed once for every one of its Diagnostics. */
function textDiagnosticBlock(
  source: string,
  diagnostic: Diagnostic,
  shared: ReadonlySet<string> = new Set(),
): string {
  return [
    indent(formatDiagnostic(diagnostic.diagnostic), "  "),
    `    rule: ${diagnostic.ruleId}`,
    `    source: ${source}`,
    ...(diagnostic.confidence ? [`    confidence: ${diagnostic.confidence}`] : []),
    ...(diagnostic.origin ? [`    origin: ${originSummary(diagnostic.origin)}`] : []),
    ...(diagnostic.evidence ?? [])
      .filter((item) => !shared.has(evidenceKey(item)))
      .map((item) => `    evidence: ${item.kind}: ${item.summary}`),
  ].join("\n");
}

/** `path:line:column` relative to `root`, or the path alone for an unlocated Diagnostic. */
export function diagnosticLocation(root: string, diagnostic: Diagnostic): string {
  const path = relative(root, diagnostic.file) || ".";
  return diagnostic.range ? `${path}:${diagnostic.range.line}:${diagnostic.range.column}` : path;
}

type OriginTag = "code" | "code+live" | "live";

/** Whether the source, a live target such as a deployed server, or both showed the Diagnostic. */
function originTag(diagnostic: Diagnostic): OriginTag {
  if (!diagnostic.origin?.live?.length) return "code";
  return diagnostic.origin.code === "found" ? "code+live" : "live";
}

const SOURCE_STATES: Record<DiagnosticOrigin["code"], string> = {
  found: "the source has it too",
  passes: "the source passes the static check; check the deployment and runtime configuration",
  "not-checked": "the source was not verified",
  "no-definition": "no unique source definition matched",
};

function originSummary(origin: DiagnosticOrigin): string {
  const live = origin.live?.map((target) => target.target).join(", ");
  return live ? `live at ${live}; ${SOURCE_STATES[origin.code]}` : SOURCE_STATES[origin.code];
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

function reportBudget(context: DoctorReportContext, format: "text" | "agent"): number {
  return context.runOptions?.maxChars ?? defaultReportBudget(context.reader ?? "pipe", format);
}

function groupDiagnostics(result: DoctorRunResult): ReportGroup[] {
  const ordered = reportOrder(result.diagnostics).map((diagnostics): ReportGroup => {
    const [diagnostic] = diagnostics as [Diagnostic];
    return {
      key: reportGroupKey(diagnostic),
      severity: diagnostic.severity,
      code: diagnostic.code,
      ruleId: diagnostic.ruleId,
      title:
        result.ruleTitles?.[diagnostic.ruleId] ??
        diagnosticMetadataByCode.get(diagnostic.code)?.title ??
        diagnostic.ruleId,
      confidence: diagnostic.confidence,
      docs: diagnostic.docs,
      diagnostics,
      evidence: [],
    };
  });
  for (const group of ordered) {
    const fixes = new Set(group.diagnostics.map((diagnostic) => diagnostic.diagnostic.fix));
    const [fix] = fixes;
    if (fixes.size === 1 && fix) group.fix = fix;
    const evidence = new Map<string, { item: DiagnosticEvidence; count: number }>();
    for (const diagnostic of group.diagnostics) {
      const seen = new Set<string>();
      for (const item of diagnostic.evidence ?? []) {
        const key = evidenceKey(item);
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

function evidenceKey(item: DiagnosticEvidence): string {
  return JSON.stringify([
    item.kind,
    item.summary,
    item.file,
    item.range && [item.range.start, item.range.end, item.range.line, item.range.column],
    item.relatedId,
  ]);
}

/**
 * The MCP servers a Doctor Run without a project checked, by endpoint label. Without a project
 * they are the run's subject, so reports name them instead of a fallback framework.
 */
function mcpSubject(result: DoctorRunResult): string[] | undefined {
  if (!result.project.noProject) return undefined;
  const servers = mcpServerLabels(result.project.runtimeEvidence);
  return servers.length ? servers : undefined;
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
  textEnding = "\n",
): ProgressiveOutcome {
  const groups = groupDiagnostics(result);
  const layout =
    format === "agent"
      ? agentLayout(result, context, groups, maxChars)
      : textLayout(result, context, groups, maxChars, textEnding);
  if (layout.completeSize <= maxChars) {
    const complete = layout.groups.map((group) => ({
      header: true,
      rows: group.rows.length,
      detail: true,
    }));
    return { report: layout.render(complete, []), groups, shown: complete };
  }

  let units = planReportBudget(layout.fixed, layout.groups, maxChars);
  const reruns = new Map<string, ProgressiveOutcome>();
  for (;;) {
    const shown = shownGroups(layout.groups, units);
    const hints = groups.map((group, index) => {
      const state = shown[index]!;
      if (!state.header || !groupHidden(group, state)) return undefined;
      if (group.ruleId.startsWith("doctor/")) return "full";
      return {
        rules: group.ruleId,
        full:
          !withHints ||
          !ruleRerunShowsMore(result, context, format, maxChars, group, state, reruns),
      };
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
    const budget =
      context.surface === "plugin"
        ? maxChars
        : defaultReportBudget(context.reader ?? "pipe", format);
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
  ending: string,
): ProgressiveLayout {
  const cost = (lines: string[]) => lines.reduce((total, line) => total + line.length + 1, 0);
  const head = textHead(result, groups);
  const tail = textTail(result);
  const total = result.diagnostics.length;
  const codes = new Set(groups.map((group) => group.code)).size;
  const plugin = context.surface === "plugin";
  const projectPath = context.cwd ? relative(context.cwd, result.root) || "." : undefined;
  const commandRoot =
    projectPath === undefined ||
    projectPath === "." ||
    projectPath === ".." ||
    projectPath.startsWith("../") ||
    isAbsolute(projectPath)
      ? projectPath
      : `./${projectPath}`;
  const command = (options: Omit<RunCommand, "root" | "format">) =>
    runArguments(result, context, { ...options, root: commandRoot, format: context.formatFlag })
      .map(shellArgument)
      .join(" ");
  const commands = plugin
    ? undefined
    : { more: command({ rules: null }), full: command({ full: true }) };
  const plural = (count: number, noun: string) =>
    `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
  const tagged = result.diagnostics.some((diagnostic) => diagnostic.origin?.live?.length);
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
        ? [
            `One group: ${commands.more} plus its "more:" flags`,
            `Everything: ${commands.full}`,
            ...(commands.full.includes(REDACTED) ? [REDACTED_NOTE] : []),
          ]
        : [
            "More: apply the group's options, or set maxChars: Infinity in the Doctor plugin options",
          ]),
    ];
  };
  const worstFooter = Math.max(
    cost(footer({ groups: groups.length, rows: total, detail: total }, codes)),
    cost(footer({ groups: 0, rows: 0, detail: total }, 0)),
  );
  const hintLine = (hint: GroupHint) => {
    if (plugin) {
      const options = pluginHint(hint);
      const fields = [];
      if ("rules" in options) fields.push(`rules: ${JSON.stringify(options.rules)}`);
      if (options.maxChars) fields.push("maxChars: Infinity");
      return `  more: ${fields.join(", ")}`;
    }
    return hint === "full"
      ? "  more: use Everything below"
      : `  more: ${cliHint(hint).map(shellArgument).join(" ")}`;
  };
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
      const deployment = diagnostic.origin?.code === "passes" ? " · check deployment" : "";
      const tag = tagged ? `${originTag(diagnostic).padEnd(9)}  ` : "";
      const text = (diagnostic.brief ?? diagnostic.why).replaceAll(
        "\n",
        `\n${" ".repeat(tag.length + width + 4)}`,
      );
      return `  ${tag}${labels[row]!.padEnd(width)}  ${text}${deployment}${safety}`;
    });
    const trailer = (hiddenRows: number, hint: GroupHint | undefined) => [
      ...(hiddenRows ? [`  (${plural(hiddenRows, "more row")})`] : []),
      ...(group.fix ? [`  fix: ${group.fix.replaceAll("\n", "\n       ")}`] : []),
      ...group.evidence.map(
        (entry) =>
          `  evidence: ${entry.item.kind}: ${entry.item.summary}${entry.count < count ? ` (${entry.count} of ${count})` : ""}`,
      ),
      `  rule: ${group.ruleId}${group.docs ? ` · see: ${group.docs}` : ""}`,
      ...(hint ? [hintLine(hint)] : []),
    ];
    // Evidence every Diagnostic of the group carries is printed once, above their blocks.
    const shared = count > 1 ? group.evidence.filter((entry) => entry.count === count) : [];
    const sharedKeys = new Set(shared.map((entry) => evidenceKey(entry.item)));
    const details = [
      ...shared.map((entry) => `  evidence: ${entry.item.kind}: ${entry.item.summary}`),
      ...group.diagnostics.map((diagnostic, row) =>
        textDiagnosticBlock(labels[row]!, diagnostic, sharedKeys),
      ),
    ];
    const headingSize = cost(heading) + cost(title);
    const trailerSize = cost(trailer(count, { rules: group.ruleId, full: true }));
    const detailSize = cost(details);
    const rowCosts = rows.map((row) => row.length + 1);
    return {
      heading,
      title,
      rows,
      details,
      trailer,
      completeSize: headingSize + detailSize,
      budget: {
        tier: SEVERITIES.indexOf(group.severity),
        header: headingSize + trailerSize,
        rows: rowCosts,
        detail: detailSize - rowCosts.reduce((sum, row) => sum + row, 0) - trailerSize,
      },
    };
  });
  const budgetGroups = parts.map((part) => part.budget);
  const baseSize = cost(head) + cost(tail) + ending.length - 1;
  return {
    fixed: baseSize + worstFooter,
    completeSize: parts.reduce((sum, part) => sum + part.completeSize, baseSize),
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
      return [...head, ...body, ...tail, ...footer(hidden, hiddenCodes)].join("\n") + ending;
    },
  };
}

function textHead(result: DoctorRunResult, groups: ReportGroup[]): string[] {
  const lines: string[] = [];
  const status = reportStatus(result);
  const subject = mcpSubject(result);
  if (subject) {
    lines.push(
      `Checked: ${subject.length === 1 ? "MCP server" : "MCP servers"} ${subject.join(", ")}`,
    );
    lines.push(`Project: none, ${result.root} has no package.json`);
  } else {
    lines.push(`Detected: ${frameworkLabel(result)}`);
    lines.push(`Project: ${result.root}`);
  }
  if (status === "incomplete") {
    lines.push(
      `Status: incomplete, required ${subject ? "MCP server" : "project"} evidence is missing`,
    );
  }
  for (const gap of result.project.evidenceGaps ?? []) {
    lines.push(
      `Evidence missing: ${gap.message}${gap.files.length ? ` ${gap.files.join(", ")}` : ""}`,
    );
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
  const subject = mcpSubject(result);
  return `${JSON.stringify(
    {
      version: result.version,
      reportVersion: result.reportVersion ?? 4,
      fingerprintScheme: FINGERPRINT_SCHEME,
      status: reportStatus(result),
      subject: subject && { mcpServers: subject },
      framework: subject ? null : result.framework,
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
      sources: result.evidenceSources?.map(({ name, label, targets }) => ({
        name,
        label,
        targets,
      })),
      workspacePackages: subject ? undefined : result.workspacePackages,
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
  return progressiveReport(result, context, "agent", reportBudget(context, "agent"), true).report;
}

function agentLayout(
  result: DoctorRunResult,
  context: DoctorReportContext,
  groups: ReportGroup[],
  maxChars: number,
): ProgressiveLayout {
  const status = reportStatus(result);
  const plugin = context.surface === "plugin";
  const subject = mcpSubject(result);
  const commandArgs = plugin
    ? undefined
    : {
        explain: [
          "vite-doctor",
          "explain",
          "<code>",
          ...(subject ? [] : ["--framework", agentFramework(result, context)]),
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
  const commands =
    commandArgs &&
    Object.fromEntries(
      Object.entries(commandArgs).map(([name, args]) => [name, args.map(shellArgument).join(" ")]),
    );
  const placeholders = commandArgs?.rerun.some((arg) => arg.includes(REDACTED))
    ? { [REDACTED]: REDACTED_NOTE }
    : undefined;
  const recovery = plugin
    ? "Rerun the host with the group's more options or pluginOptions.full (use numeric Infinity for maxChars)."
    : "To see what the Report Budget hid, append a group's more items to commandArgs.more, or use commandArgs.full when no more items are given.";
  const codes = codeIndex(groups);
  const total = result.diagnostics.length;
  const live = result.diagnostics.filter((diagnostic) => diagnostic.origin?.live?.length);
  const verifyLive = live.length ? " Verify live findings against the same target." : "";
  const deployment = live.some((diagnostic) => diagnostic.origin?.code === "passes")
    ? ' When origin.code is "passes", check the deployed version and runtime configuration before editing source or redeploying.'
    : "";
  const liveGuidance = verifyLive + deployment;
  const serialize = (budget: object | undefined, items: object[]) =>
    `${JSON.stringify({
      schema: "vite-doctor.agent/v3",
      status,
      subject: subject && { mcpServers: subject },
      project: subject
        ? null
        : {
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
      commands,
      commandArgs,
      placeholders,
      pluginOptions: plugin && budget ? { full: FULL_PLUGIN_OPTIONS } : undefined,
      next:
        status === "clean"
          ? { action: "none" }
          : status === "incomplete"
            ? {
                action: "restore-evidence",
                instruction: `${
                  result.project.evidenceGaps?.map((gap) => gap.message).join(" ") ||
                  "Install project dependencies and run Doctor from the target package before relying on version-specific results."
                }${liveGuidance}`,
              }
            : {
                action: "remediate",
                instruction: `Apply the smallest remediation that resolves each owned diagnostic${plugin ? "" : ", run its focused verification"}, then rerun Doctor.${liveGuidance}${budget ? ` ${recovery}` : ""}`,
              },
    })}\n`;
  const budgetField = (hidden: BudgetHidden) => ({ maxChars, hidden });
  const jsonItemSize = (value: unknown) => JSON.stringify(value).length + 1;
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
      more: hint && (plugin ? pluginHint(hint) : hint === "full" ? undefined : cliHint(hint)),
      rowsHidden: rowsHidden || undefined,
    });
    const rows = group.diagnostics.map((diagnostic) => agentRow(result, diagnostic));
    const details = group.diagnostics.map((diagnostic) => agentDetail(result, diagnostic));
    const rowCosts = rows.map(jsonItemSize);
    const detailSize = agentDetailSize(details, maxChars);
    const completeHeader = JSON.stringify({ ...head(undefined, 0), diagnostics: [] });
    return {
      head,
      rows,
      details,
      completeSize: completeHeader.length + detailSize,
      budget: {
        tier: SEVERITIES.indexOf(group.severity),
        header: jsonItemSize({
          ...head({ rules: group.ruleId, full: true }, count),
          diagnostics: [],
        }),
        rows: rowCosts,
        detail: detailSize + 1 - rowCosts.reduce((sum, row) => sum + row, 0),
      },
    };
  });
  const budgetGroups = parts.map((part) => part.budget);
  return {
    fixed: serialize(budgetField({ groups: groups.length, rows: total, detail: total }), []).length,
    completeSize: parts.reduce(
      (sum, part) => sum + part.completeSize,
      serialize(undefined, []).length + Math.max(0, parts.length - 1),
    ),
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

function agentDetailSize(details: object[], maxChars: number): number {
  let size = 0;
  for (const [index, detail] of details.entries()) {
    size += JSON.stringify(detail).length + (index === 0 ? 0 : 1);
    if (size > maxChars) return Infinity;
  }
  return size;
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
    origin: diagnostic.origin,
    ...(diagnostic.brief ? { brief: diagnostic.brief } : { message: diagnostic.why }),
    fixSafety: diagnostic.fix?.kind,
  };
}

function agentDetail(result: DoctorRunResult, diagnostic: Diagnostic) {
  return {
    fingerprint: diagnostic.fingerprint,
    location: agentLocation(result, diagnostic),
    subject: diagnostic.subject,
    origin: diagnostic.origin,
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
              origin: diagnostic.origin,
              data: diagnostic.data,
            },
            locations: [
              {
                // What a live target sent, such as an MCP tool, named beside where to fix it.
                logicalLocations:
                  diagnostic.origin?.live?.length && diagnostic.subject
                    ? [{ name: diagnostic.subject, kind: "resource" }]
                    : undefined,
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
  return progressiveReport(result, context, "text", reportBudget(context, "text"), true).report;
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
  if (unresolvedRuntimeInventory(result.project).length) {
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
    origin: diagnostic.origin,
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
  const args = mcpSubject(result)
    ? ["vite-doctor", command.root ?? result.root]
    : ["vite-doctor", command.root ?? ".", "--framework", agentFramework(result, context)];
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
  for (const target of options?.mcp ?? []) args.push("--mcp-url", commandMcpUrl(target.url));
  for (const name of Object.keys(options?.mcp?.[0]?.headers ?? {}))
    if (isMcpHeaderName(name)) args.push("--mcp-header", `${name}: ${REDACTED}`);
  for (const source of result.evidenceSources ?? []) args.push(...source.args);
  if (options?.newOnly) args.push("--new-only");
  if (options?.profile) args.push("--profile");
  if (options?.cache !== undefined) args.push(options.cache ? "--cache" : "--no-cache");
  if (command.full) args.push("--full");
  if (command.format) args.push("--format", command.format);
  return args;
}

const REDACTED_NOTE =
  "Doctor redacts flag values that can carry secrets, such as --mcp-header values and the credentials, query strings, and custom paths of an --mcp-url. Replace each <redacted> with the value you ran with.";
const PUBLIC_MCP_PATHS = new Set(["/", "/mcp", "/sse", "/v1/sse", "/github-copilot/mcp"]);

function commandMcpUrl(value: string): string {
  const url = parseMcpEndpoint(value);
  if (!url) return REDACTED;
  const credentials = url.username || url.password ? `${REDACTED}@` : "";
  const path = PUBLIC_MCP_PATHS.has(url.pathname) ? url.pathname : `/${REDACTED}`;
  const query = url.search ? `?${REDACTED}` : "";
  return `${url.protocol}//${credentials}${url.host}${path}${query}`;
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
