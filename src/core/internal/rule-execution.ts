import { resolve } from "pathe";
import type {
  Diagnostic,
  DoctorRule,
  ProjectInfo,
  RuleContext,
  RuleVisitor,
  SfcHandle,
  SourceFileHandle,
} from "../primitives.js";
import { projectWorkspacePackages } from "./applicability.js";
import { isScriptVisitorKey, runVisitors } from "./rule-runner.js";
import { canMatchPrefilter } from "./rule-prefilter.js";
import { owningWorkspacePackage } from "./workspace-packages.js";
import { workspaceNuxtRoots, workspaceProjectView } from "./workspace-nuxt.js";
import {
  buildWorkspaceGraph,
  runDuplicationRules,
  runHealthRules,
  runStructuralGraphRules,
} from "./workspace-graph.js";
import {
  createDiagnosticFingerprint,
  defaultConfidenceForPhase,
  evidenceKindForPhase,
  normalizeDiagnostic,
  sourceTextFor,
} from "./diagnostics.js";
import {
  markSession,
  recordRuleTiming,
  resolvedConfigFor,
  type RuleTiming,
  type ScanSession,
} from "./scan-session.js";
import { nativeMatch, sha256 } from "./utils.js";

interface MutableRuleContext extends RuleContext {
  setFile(file: SourceFileHandle): void;
}

export async function runFileRules(session: ScanSession): Promise<void> {
  if (session.options.analyses && !session.options.rules) return;
  const started = performance.now();
  const rules = session.enabledRules.filter((rule) => (rule.meta.execution ?? "file") === "file");
  // Buffering per rule keeps report order rule-major, as it was when rules ran one at a time.
  const reported = rules.map((): Diagnostic[] => []);
  const timings = session.options.profile ? rules.map(() => ({ ms: 0, files: 0 })) : undefined;
  const workspacePackages = projectWorkspacePackages(session.project);
  for (const file of session.handles) {
    const visitors: RuleVisitor[] = [];
    const owner = session.ruleScopes.size
      ? owningWorkspacePackage(workspacePackages, file.relativePath)
      : ".";
    for (const [index, rule] of rules.entries()) {
      if (!canRunRuleOnFile(rule, file)) continue;
      if (!canMatchPrefilter(rule, file)) continue;
      if (session.ruleScopes.get(rule.meta.id)?.has(owner) === false) continue;
      const context = createRuleContext(session, file, rule, "file", reported[index]);
      if (!timings) {
        const visitor = await rule.create(context);
        if (visitor) visitors.push(visitor);
        continue;
      }
      const timing = timings[index]!;
      const createStarted = performance.now();
      const visitor = await rule.create(context);
      timing.ms += performance.now() - createStarted;
      timing.files += 1;
      if (visitor) visitors.push(timeVisitor(visitor, timing));
    }
    if (visitors.length > 0) await runVisitors(visitors, file);
  }
  for (const diagnostics of reported) {
    for (const diagnostic of diagnostics) session.diagnostics.push(diagnostic);
  }
  if (timings) {
    for (const [index, rule] of rules.entries()) {
      const timing = timings[index]!;
      if (timing.files === 0) continue;
      const total = session.ruleTimings.get(rule.meta.id) ?? { ms: 0, files: 0 };
      total.ms += timing.ms;
      total.files += timing.files;
      session.ruleTimings.set(rule.meta.id, total);
    }
  }
  markSession(session, "fileRules", started);
}

function timeVisitor(visitor: RuleVisitor, timing: RuleTiming): RuleVisitor {
  const timed: Record<string, unknown> = {};
  if (visitor.SFC)
    timed.SFC = async (sfc: SfcHandle) => {
      const started = performance.now();
      try {
        await visitor.SFC!(sfc);
      } finally {
        timing.ms += performance.now() - started;
      }
    };
  if (visitor.TemplateNode)
    timed.TemplateNode = (node: unknown) => timeCall(timing, () => visitor.TemplateNode!(node));
  for (const key in visitor) {
    if (!isScriptVisitorKey(key)) continue;
    const handler = (visitor as Record<string, unknown>)[key];
    if (typeof handler !== "function") continue;
    timed[key] = (node: unknown) => timeCall(timing, () => handler.call(visitor, node));
  }
  return timed as RuleVisitor;
}

function timeCall(timing: RuleTiming, call: () => void): void {
  const started = performance.now();
  try {
    call();
  } finally {
    timing.ms += performance.now() - started;
  }
}

export async function runManifestRules(session: ScanSession): Promise<void> {
  if (session.options.analyses && !session.options.rules) return;
  const started = performance.now();
  const fallbackFile = session.handles[0] ?? createEmptySourceFileHandle(session);
  const nuxtRoots = workspaceNuxtRoots(session.project);
  for (const rule of session.enabledRules) {
    if (rule.meta.execution !== "manifest" && rule.meta.execution !== "workspace") continue;
    const ruleStarted = performance.now();
    for (const project of manifestRuleProjects(session, rule, nuxtRoots)) {
      const file =
        project === session.project
          ? fallbackFile
          : (session.handles.find((handle) => handle.project === project) ?? fallbackFile);
      const visitor = await rule.create(
        createRuleContext(session, file, rule, rule.meta.execution, undefined, project),
      );
      await visitor?.onWorkspaceStart?.();
      await visitor?.onProjectStart?.(project);
      if (project.nuxt) visitor?.NuxtManifest?.(project.nuxt);
      await visitor?.onProjectEnd?.(project);
      await visitor?.onWorkspaceEnd?.();
    }
    if (session.options.profile) recordRuleTiming(session, rule.meta.id, ruleStarted, 0);
  }
  markSession(session, "manifestRules", started);
}

/**
 * Nuxt manifest Rules run once per Nuxt Project Inventory in their scope, so each Nuxt workspace
 * package is reviewed against its own inventory. Other manifest Rules run once per Doctor Run.
 */
function manifestRuleProjects(
  session: ScanSession,
  rule: DoctorRule,
  nuxtRoots: readonly string[],
): ProjectInfo[] {
  if (!rule.meta.requires?.nuxt || !nuxtRoots.length) return [session.project];
  const scope = session.ruleScopes.get(rule.meta.id);
  const inScope = nuxtRoots.filter((root) => !scope || scope.has(root));
  const runOwner =
    session.project.nuxt && (!scope || [...scope].some((root) => !nuxtRoots.includes(root)));
  return [
    ...(runOwner ? [session.project] : []),
    ...inScope.map((root) => workspaceProjectView(session.project, root)),
  ];
}

export async function buildGraphPhase(session: ScanSession): Promise<void> {
  session.graph = buildWorkspaceGraph(session);
}

export async function runGraphRules(session: ScanSession): Promise<void> {
  if (!session.graph) return;
  runStructuralGraphRules(session, session.graph);
}

export async function runDuplicationPhase(session: ScanSession): Promise<void> {
  runDuplicationRules(session);
}

export async function runHealthPhase(session: ScanSession): Promise<void> {
  runHealthRules(session);
}

function createRuleContext(
  session: ScanSession,
  initialFile: SourceFileHandle,
  rule: DoctorRule,
  phase: Diagnostic["analysisPhase"] = "file",
  sink?: Diagnostic[],
  project: ProjectInfo = phase === "file" ? initialFile.project : session.project,
): MutableRuleContext {
  let file = initialFile;
  const frame = session.ruleInputs.frame();
  const currentRuleConfig = resolvedConfigFor(session, rule.meta.id);
  const currentSeverity = currentRuleConfig.severity ?? rule.meta.severity;
  return {
    get project() {
      return project;
    },
    get file() {
      return file;
    },
    get sfc() {
      return file.sfc;
    },
    get severity() {
      return currentSeverity;
    },
    get options() {
      return currentRuleConfig.options;
    },
    setFile(nextFile) {
      file = nextFile;
    },
    report(diagnostic, metadata = {}) {
      const input = normalizeDiagnostic({
        ...metadata,
        ruleId: metadata.ruleId ?? rule.meta.id,
        severity: metadata.severity ?? currentSeverity,
        category: metadata.category ?? rule.meta.category,
        diagnostic,
        file: metadata.file ?? file.path,
      });
      const diagnosticConfig = resolvedConfigFor(session, input.ruleId);
      if (diagnosticConfig.enabled === false) return;
      const severity =
        diagnosticConfig.severity ??
        currentRuleConfig.severity ??
        input.severity ??
        rule.meta.severity;
      const next = {
        ...input,
        severity,
        confidence: input.confidence ?? defaultConfidenceForPhase(phase),
        evidence: input.evidence ?? [
          { kind: evidenceKindForPhase(phase), summary: `${phase} analysis` },
        ],
        analysisPhase: input.analysisPhase ?? phase,
        fingerprint:
          input.fingerprint ??
          createDiagnosticFingerprint(
            session.root,
            input,
            input.file === file.path ? file.text : sourceTextFor(session, input.file),
          ),
      };
      (sink ?? session.diagnostics).push(next);
    },
    fs: frame.fs,
    cache: frame.cache,
    helpers: session.helpers,
    range(nodeOrStart, end) {
      if (nodeOrStart === undefined || nodeOrStart === null) return undefined;
      if (typeof nodeOrStart === "number")
        return session.helpers.rangeFromOffsets(file.path, file.text, nodeOrStart, end);
      const node = nodeOrStart as { start?: number; end?: number; range?: [number, number] };
      const start = node.start ?? node.range?.[0];
      const stop = node.end ?? node.range?.[1] ?? start;
      return typeof start === "number"
        ? session.helpers.rangeFromOffsets(file.path, file.text, start, stop)
        : undefined;
    },
  };
}

function createEmptySourceFileHandle(session: ScanSession): SourceFileHandle {
  const path = resolve(session.root, "__doctor_empty__.ts");
  return {
    path,
    relativePath: "__doctor_empty__.ts",
    sourceKind: "app",
    text: "",
    hash: sha256(""),
    isVueSfc: false,
    scriptAst: null,
    templateAst: null,
    project: session.project,
    matches(pattern) {
      return nativeMatch(this.relativePath, pattern);
    },
    inAppDir() {
      return false;
    },
    isModuleSource() {
      return false;
    },
  };
}

function canRunRuleOnFile(rule: DoctorRule, file: SourceFileHandle): boolean {
  if (rule.meta.sourceKinds && !rule.meta.sourceKinds.includes(file.sourceKind)) return false;
  const requires = rule.meta.requires;
  if (!requires) return true;
  if (requires.sfc && !file.sfc) return false;
  if (requires.template && !file.templateAst) return false;
  if (requires.script && !file.scriptAst) return false;
  return true;
}
