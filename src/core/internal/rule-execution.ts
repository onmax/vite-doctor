import { isNumber, isRecord } from "./value-schema.js";
import { readFileSync } from "node:fs";
import { resolve } from "pathe";
import type { Diagnostic, DoctorRule, RuleContext, SourceFileHandle } from "../primitives.js";
import { runVisitor } from "./rule-runner.js";
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
} from "./diagnostics.js";
import { markSession, resolvedConfigFor, type ScanSession } from "./scan-session.js";
import { nativeMatch, sha256 } from "./utils.js";

interface MutableRuleContext extends RuleContext {
  setFile(file: SourceFileHandle): void;
}

export async function runFileRules(session: ScanSession): Promise<void> {
  if (session.options.analyses && !session.options.rules) return;
  const started = performance.now();
  for (const rule of session.enabledRules) {
    if ((rule.meta.execution ?? "file") !== "file") continue;
    for (const file of session.handles) {
      if (!canRunRuleOnFile(rule, file)) continue;
      const visitor = await rule.create(createRuleContext(session, file, rule));
      if (!visitor) continue;
      await runVisitor(visitor, file);
    }
  }
  markSession(session, "fileRules", started);
}

export async function runManifestRules(session: ScanSession): Promise<void> {
  if (session.options.analyses && !session.options.rules) return;
  const started = performance.now();
  const fallbackFile = session.handles[0] ?? createEmptySourceFileHandle(session);
  for (const rule of session.enabledRules) {
    const visitor = await rule.create(createRuleContext(session, fallbackFile, rule, "manifest"));
    await visitor?.onWorkspaceStart?.();
    await visitor?.onProjectStart?.(session.project);
    if (session.project.nuxt) visitor?.NuxtManifest?.(session.project.nuxt);
    await visitor?.onProjectEnd?.(session.project);
    await visitor?.onWorkspaceEnd?.();
  }
  markSession(session, "manifestRules", started);
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
): MutableRuleContext {
  let file = initialFile;
  const currentRuleConfig = resolvedConfigFor(session, rule.meta.id);
  const currentSeverity = currentRuleConfig.severity ?? rule.meta.severity;
  return {
    get project() {
      return session.project;
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
    report(diagnostic, metadata) {
      const input = normalizeDiagnostic({
        ...metadata,
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
        fingerprint: input.fingerprint ?? createDiagnosticFingerprint(session.root, input, file),
      };
      session.diagnostics.push(next);
    },
    getFileText(target) {
      return readFileSync(resolve(session.root, target), "utf8");
    },
    getJson<T>(target: string, parse: (value: unknown) => T): T | null {
      try {
        const value: unknown = JSON.parse(readFileSync(resolve(session.root, target), "utf8"));
        return parse(value);
      } catch {
        return null;
      }
    },
    cache: session.cache,
    helpers: session.helpers,
    range(nodeOrStart, end) {
      if (!nodeOrStart) return undefined;
      if (isNumber(nodeOrStart))
        return session.helpers.rangeFromOffsets(file.path, file.text, nodeOrStart, end);
      if (!isRecord(nodeOrStart)) return undefined;
      const range = Array.isArray(nodeOrStart.range) ? nodeOrStart.range : [];
      const start = isNumber(nodeOrStart.start) ? nodeOrStart.start : range[0];
      const stop = isNumber(nodeOrStart.end) ? nodeOrStart.end : (range[1] ?? start);
      return isNumber(start)
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
