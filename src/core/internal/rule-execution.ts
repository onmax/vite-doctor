import { relative, resolve } from "pathe";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import type {
  Diagnostic,
  DoctorRule,
  ProjectInfo,
  RuleContext,
  RuleVisitor,
  SfcHandle,
  SourceFileHandle,
  WorkspaceGraph,
} from "../primitives.js";
import type { GraphSummary } from "./cache-store.js";
import { projectWorkspacePackages } from "./applicability.js";
import { componentUsageGraph } from "./component-inventory.js";
import {
  canRunRuleOnFile,
  isTestFileHandle,
  loadSourceFile,
  sourceFacts,
  sourceShape,
} from "./facts.js";
import type { RuleInputFrame } from "./rule-inputs.js";
import { assertKnownRuleHooks } from "./rule-hooks.js";
import { isScriptVisitorKey, runVisitors } from "./rule-runner.js";
import { canMatchPrefilter } from "./rule-prefilter.js";
import { workspaceNuxtRoots, workspaceProjectView, workspaceViewRoot } from "./workspace-nuxt.js";
import { nuxtInventoryOwner, owningWorkspacePackage } from "./workspace-packages.js";
import {
  buildWorkspaceGraph,
  importGraphInventory,
  runDuplicationRules,
  runHealthRules,
  runStructuralGraphRules,
} from "./workspace-graph.js";
import { createDiagnosticFingerprint, normalizeDiagnostic, sourceTextFor } from "./diagnostics.js";
import {
  analyzesTestFiles,
  fileRuleConfig,
  markSession,
  recordRuleTiming,
  ruleInScope,
  runsFileRules,
  topLevelRuleConfig,
  type ResolvedRuleConfig,
  type RuleTiming,
  type ScanSession,
} from "./scan-session.js";
import { nativeMatch, nodeOffsets, sha256 } from "./utils.js";
import { selectHtmlPaths } from "./source-inventory.js";

interface RuleRun {
  context: RuleContext;
  frame: RuleInputFrame;
  /** Whether the Rule read Project Inventory derived from every source file, which no Rule input tracks. */
  readsInventory: boolean;
}

export async function runFileRules(session: ScanSession): Promise<void> {
  if (!runsFileRules(session.options)) return;
  const started = performance.now();
  const rules = session.enabledRules.filter((rule) => (rule.meta.execution ?? "file") === "file");
  const keys = rules.map((rule) => cacheKeyFor(session, rule));
  // Buffering per rule keeps report order rule-major, as it was when rules ran one at a time.
  const reported = rules.map((): Diagnostic[] => []);
  const timings = session.options.profile ? rules.map(() => ({ ms: 0, files: 0 })) : undefined;
  const reportedFiles = session.scopedReport
    ? new Set(
        [...session.files, ...session.testFiles].flatMap((file) =>
          file.reportEligibility ? [file.path] : [],
        ),
      )
    : undefined;
  const testRules = [...rules.keys()].filter((index) => analyzesTestFiles(rules[index]!));
  for (const file of [...session.handles, ...session.testHandles]) {
    const fileRules = isTestFileHandle(file) ? testRules : [...rules.keys()];
    // File-scoped Rules can only report into the file they analyze, so a scoped run needs them on
    // the reported files only; project-scoped Rules keep whole-project context.
    const candidates =
      reportedFiles && !reportedFiles.has(file.path)
        ? fileRules.filter((index) => rules[index]!.meta.reportScope === "project")
        : fileRules;
    if (!candidates.length) continue;
    if (sourceShape(file) === undefined) await loadSourceFile(file);
    const ran = file.text.includes("doctor-disable") ? new Set<string>() : undefined;
    if (ran) session.fileRuleRuns.set(file.path, ran);
    const pending: Array<{ index: number; config: ResolvedRuleConfig }> = [];
    for (const index of candidates) {
      const rule = rules[index]!;
      if (!canRunRuleOnFile(rule, file)) continue;
      const config = fileRuleConfig(session, rule.meta.id, file.path);
      if (
        !config.enabled &&
        (rule.meta.reportScope !== "project" || !ruleInScope(session, rule.meta.id, file.path))
      )
        continue;
      if (config.enabled) ran?.add(rule.meta.id);
      const key = keys[index];
      const cached = key ? session.cache.ruleResult(file.path, key) : undefined;
      if (cached) {
        reported[index]!.push(...cached);
        continue;
      }
      // The prefilter only reads this file's facts and text, so a skip caches as an empty result.
      if (!canMatchPrefilter(rule, file)) {
        if (key) session.cache.recordRuleResult(file.path, key, [], []);
        continue;
      }
      pending.push({ index, config });
    }
    if (!pending.length) continue;
    await loadSourceFile(file);
    const before = projectSnapshot(session.project);
    const visitors: RuleVisitor[] = [];
    const runs: Array<{ index: number; run: RuleRun; reportedBefore: number }> = [];
    for (const { index, config } of pending) {
      const rule = rules[index]!;
      const run = createRuleRun(session, file, rule, "file", reported[index], file.project, config);
      runs.push({ index, run, reportedBefore: reported[index]!.length });
      const timing = timings?.[index];
      const createStarted = timing && performance.now();
      const visitor = await rule.create(run.context);
      if (timing) {
        timing.ms += performance.now() - createStarted!;
        timing.files += 1;
      }
      if (!visitor) continue;
      assertKnownRuleHooks(rule, visitor);
      visitors.push(timing ? timeVisitor(visitor, timing) : visitor);
    }
    if (visitors.length > 0) await runVisitors(visitors, file);
    const mutated = projectChanged(session.project, before);
    for (const { index, run, reportedBefore } of runs) {
      const key = keys[index];
      if (!key) continue;
      if (mutated) session.cache.recordUncacheable();
      else
        session.cache.recordRuleResult(
          file.path,
          key,
          reported[index]!.slice(reportedBefore),
          run.frame.readInputs(),
        );
    }
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
  if (visitor.template) {
    const template: Record<string, unknown> = {};
    for (const [key, handler] of Object.entries(visitor.template as Record<string, unknown>)) {
      if (typeof handler !== "function") continue;
      template[key] = (node: unknown, parent: unknown) =>
        timeCall(timing, () => handler.call(visitor.template, node, parent));
    }
    timed.template = template;
  }
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
  if (!runsFileRules(session.options)) return;
  const started = performance.now();
  const fallbackFile = session.handles[0] ?? createEmptySourceFileHandle(session);
  const nuxtRoots = workspaceNuxtRoots(session.project);
  const nuxtAnchors = new Map<ProjectInfo, SourceFileHandle>();
  for (const rule of session.enabledRules) {
    if (rule.meta.execution !== "manifest" && rule.meta.execution !== "workspace") continue;
    const key = cacheKeyFor(session, rule);
    const ruleStarted = performance.now();
    for (const project of manifestRuleProjects(session, rule, nuxtRoots)) {
      let file = fallbackFile;
      const nuxtInventory = rule.meta.requires?.nuxt && project.nuxt;
      if (nuxtInventory) {
        file = nuxtAnchors.get(project) ?? nuxtManifestAnchor(session, project);
        nuxtAnchors.set(project, file);
      }
      const viewKey = key && `${key}:${workspaceViewRoot(project) ?? ""}`;
      const resultKey = viewKey && (nuxtInventory ? `${viewKey}:${file.relativePath}` : viewKey);
      const cached = resultKey ? session.cache.ruleResult(undefined, resultKey) : undefined;
      if (cached) {
        session.diagnostics.push(...cached);
        continue;
      }
      const before = projectSnapshot(session.project);
      const reportedBefore = session.diagnostics.length;
      const run = createRuleRun(session, file, rule, rule.meta.execution, undefined, project);
      const visitor = await rule.create(run.context);
      if (visitor) assertKnownRuleHooks(rule, visitor);
      await visitor?.onWorkspaceStart?.();
      await visitor?.onProjectStart?.(project);
      if (project.nuxt) visitor?.NuxtManifest?.(project.nuxt);
      await visitor?.onProjectEnd?.(project);
      await visitor?.onWorkspaceEnd?.();
      if (!resultKey) continue;
      if (run.readsInventory || projectChanged(session.project, before))
        session.cache.recordUncacheable();
      else
        session.cache.recordRuleResult(
          undefined,
          resultKey,
          session.diagnostics.slice(reportedBefore),
          // Diagnostics without a file depend on the fallback location.
          [...run.frame.readInputs(), `t:${file.path}`],
        );
    }
    if (session.options.profile) recordRuleTiming(session, rule.meta.id, ruleStarted, 0);
  }
  markSession(session, "manifestRules", started);
}

function nuxtManifestAnchor(session: ScanSession, project: ProjectInfo): SourceFileHandle {
  const packages = projectWorkspacePackages(project);
  const packageFor = (path: string) =>
    owningWorkspacePackage(packages, relative(session.root, path));
  const manifest = project.nuxt?.manifestPath;
  const owner =
    workspaceViewRoot(project) ??
    (manifest ? packageFor(manifest) : nuxtInventoryOwner(packages)?.root) ??
    ".";
  return (
    session.handles.find((handle) => packageFor(handle.path) === owner) ??
    createEmptySourceFileHandle(
      session,
      manifest ?? resolve(session.root, owner, "package.json"),
      project,
    )
  );
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
  const analyses = selectedAnalyses(session);
  const graphAnalyses = analyses.has("dead-code") || analyses.has("graph");
  // A scoped report describes the reported files, so it skips the project graph summary unless an
  // analysis needs the graph.
  if (session.scopedReport && !graphAnalyses) return;
  const key = graphKey(session);
  if (!graphAnalyses) {
    const cached = session.cache.graph(key);
    if (cached) {
      session.graphSummary = cached;
      return;
    }
  }
  session.facts = await sourceFacts(session);
  const frame = session.ruleInputs.frame();
  session.graph = buildWorkspaceGraph(session, frame.fs);
  session.graphSummary = summarizeGraph(session.graph);
  session.cache.recordGraph(key, session.graphSummary, frame.readInputs());
}

export async function runGraphRules(session: ScanSession): Promise<void> {
  if (!session.graph) return;
  runStructuralGraphRules(session, session.graph);
}

export async function runDuplicationPhase(session: ScanSession): Promise<void> {
  if (!selectedAnalyses(session).has("dupes")) return;
  session.facts = await sourceFacts(session);
  runDuplicationRules(session);
}

export async function runHealthPhase(session: ScanSession): Promise<void> {
  if (!selectedAnalyses(session).has("health")) return;
  session.facts = await sourceFacts(session);
  for (const handle of session.handles) await loadSourceFile(handle);
  runHealthRules(session);
}

function cacheKeyFor(session: ScanSession, rule: DoctorRule): string | undefined {
  if (rule.meta.cacheScope === "none") return undefined;
  if ((rule.meta.determinism ?? "deterministic") !== "deterministic") return undefined;
  return session.ruleKeys.get(rule);
}

// Rules may add evidence gaps or inventory; such results stay uncached instead of replayed.
function projectSnapshot(project: ProjectInfo): unknown[] {
  return Object.entries(project).flat();
}

function projectChanged(project: ProjectInfo, before: unknown[]): boolean {
  const after = projectSnapshot(project);
  return after.length !== before.length || after.some((value, index) => value !== before[index]);
}

function graphKey(session: ScanSession): string {
  return sha256(
    JSON.stringify([
      session.contextKey,
      session.handles.map((file) => [
        file.path,
        file.hash,
        file.relativePath,
        file.sourceKind,
        file.moduleName,
      ]),
    ]),
  );
}

function summarizeGraph(graph: WorkspaceGraph): GraphSummary {
  return {
    files: graph.files.size,
    importEdges: graph.importEdges.length,
    exportEdges: graph.exportEdges.length,
    virtualRoots: graph.virtualRoots.length,
    cycles: graph.sccs.filter((scc) => scc.length > 1).length,
  };
}

function selectedAnalyses(session: ScanSession): Set<string> {
  return new Set(
    session.options.analyses
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [],
  );
}

function createRuleRun(
  session: ScanSession,
  file: SourceFileHandle,
  rule: DoctorRule,
  phase: Diagnostic["analysisPhase"] = "file",
  sink?: Diagnostic[],
  project: ProjectInfo = phase === "file" ? file.project : session.project,
  currentRuleConfig: ResolvedRuleConfig = topLevelRuleConfig(session, rule.meta.id),
): RuleRun {
  const frame = session.ruleInputs.frame(workspaceViewRoot(project));
  const currentSeverity = currentRuleConfig.severity ?? rule.meta.severity;
  let readsInventory = false;
  const context: RuleContext = {
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
    report(diagnostic, metadata = {}) {
      const input = normalizeDiagnostic({
        ...metadata,
        ruleId: metadata.ruleId ?? rule.meta.id,
        severity: metadata.severity ?? currentSeverity,
        category: metadata.category ?? rule.meta.category,
        diagnostic,
        file: metadata.file ?? file.path,
      });
      if (phase === "file" && rule.meta.reportScope !== "project") {
        const outside = [input.file, ...(input.related ?? []).map((item) => item.file)]
          .map((target) => resolve(session.root, target))
          .find((target) => target !== file.path);
        if (outside)
          throw doctorInternalDiagnostics.DOC0030({
            ruleId: rule.meta.id,
            file: relative(session.root, file.path),
            target: relative(session.root, outside),
          });
      }
      // Overrides apply to the file a Diagnostic is located in, which a project-scoped Rule can
      // choose, so its config is resolved per Diagnostic.
      const diagnosticConfig = fileRuleConfig(session, input.ruleId, input.file);
      if (diagnosticConfig.enabled === false) return;
      if (input.file !== file.path) frame.log.push(`t:${resolve(session.root, input.file)}`);
      const severity =
        diagnosticConfig.severity ??
        (input.ruleId === rule.meta.id ? undefined : currentRuleConfig.severity) ??
        metadata.severity ??
        rule.meta.severity;
      const next = {
        ...input,
        severity,
        confidence: input.confidence ?? rule.meta.confidence,
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
    inventory: {
      async sourcePaths(kind) {
        if (phase === "file")
          throw new Error(
            `Rule ${rule.meta.id} must use workspace execution to read source paths.`,
          );
        readsInventory = true;
        if (kind === "html") return selectHtmlPaths(session.root, session.config, session.project);
        return session.files
          .filter((entry) => entry.sourceKind !== "module")
          .map((entry) => entry.path);
      },
      componentUsage() {
        if (phase === "file")
          throw new Error(
            `Rule ${rule.meta.id} read the component usage graph from a file Rule. It covers every source file, so set meta.execution to "workspace".`,
          );
        readsInventory = true;
        return componentUsageGraph(session);
      },
      importGraph() {
        if (phase === "file")
          throw new Error(
            `Rule ${rule.meta.id} read the import graph from a file Rule. It covers every source file, so set meta.execution to "workspace".`,
          );
        readsInventory = true;
        return importGraphInventory(session);
      },
    },
    helpers: session.helpers,
    range(nodeOrStart, end) {
      if (nodeOrStart === undefined || nodeOrStart === null) return undefined;
      if (typeof nodeOrStart === "number")
        return session.helpers.rangeFromOffsets(file.path, file.text, nodeOrStart, end);
      const offsets = nodeOffsets(nodeOrStart);
      return offsets
        ? session.helpers.rangeFromOffsets(file.path, file.text, offsets.start, offsets.end)
        : undefined;
    },
  };
  return {
    context,
    frame,
    get readsInventory() {
      return readsInventory;
    },
  };
}

function createEmptySourceFileHandle(
  session: ScanSession,
  path = resolve(session.root, "__doctor_empty__.ts"),
  project = session.project,
): SourceFileHandle {
  return {
    path,
    relativePath: relative(session.root, path),
    sourceKind: "app",
    text: "",
    hash: sha256(""),
    isVueSfc: false,
    scriptAst: null,
    templateAst: null,
    project,
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
