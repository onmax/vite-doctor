import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { matchesGlob } from "node:path";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "pathe";
import MagicString from "magic-string";
import { loadConfig } from "c12";
import { visitorKeys } from "oxc-parser";
import type {
  Diagnostic,
  DynamicImportFact,
  ExportFact,
  FileFacts,
  GraphEdge,
  ImportFact,
  DoctorHelpers,
  DoctorPlugin,
  DoctorRunResult,
  DoctorRule,
  DoctorSeverity,
  ProjectInfo,
  RuleCache,
  RuleContext,
  RulePack,
  SourceFileHandle,
  TemplateFact,
  VirtualRootNode,
  WorkspaceGraph,
} from "./primitives.js";
import type { DoctorConfig, DoctorRunOptions } from "./config.js";
import { detectProject } from "./internal/project.js";
import { createVueScriptForParsing, parseSfcFile } from "./internal/sfc.js";
import { parseScript } from "./internal/script.js";
import { parseTemplate } from "./internal/template.js";
import { applyDiagnosticPolicy } from "./internal/diagnostic-policy.js";
import { runVisitor } from "./internal/rule-runner.js";
import { selectScanFiles, type ScanFileEntry } from "./internal/source-inventory.js";

export * from "./primitives.js";
export * from "./config.js";
export * from "./reports.js";
export {
  createNuxtProjectInventory,
  matchesNuxtScanRoot,
  normalizeNuxtModuleSources,
  relativeNuxtScanRoot,
} from "./internal/nuxt-inventory.js";
export { default as vueRulePack } from "./rules/vue.js";

const VERSION = "0.0.0";
const DEFAULT_WEIGHTS = { blocker: 15, error: 8, warn: 3, info: 1 };

class MemoryRuleCache implements RuleCache {
  private values = new Map<string, unknown>();
  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }
}

class PersistentRuleCache extends MemoryRuleCache {
  private dir: string;

  constructor(root: string, config: DoctorConfig) {
    super();
    this.dir = resolve(root, config.cache?.dir ?? ".vue-doctor/cache");
  }

  override get<T = unknown>(key: string): T | undefined {
    const memory = super.get<T>(key);
    if (memory !== undefined) return memory;
    if (!key.startsWith("fileFacts:")) return undefined;
    try {
      const value = JSON.parse(
        readFileSync(resolve(this.dir, `${safeCacheKey(key)}.json`), "utf8"),
      );
      super.set(key, value);
      return value as T;
    } catch {
      return undefined;
    }
  }

  override set<T = unknown>(key: string, value: T): void {
    super.set(key, value);
    if (!key.startsWith("fileFacts:")) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(resolve(this.dir, `${safeCacheKey(key)}.json`), JSON.stringify(value));
    } catch {
      // Cache writes are best-effort and must not change diagnostics.
    }
  }
}

interface RuleRegistry {
  packs: RulePack[];
  rules: DoctorRule[];
}

interface ScanSession {
  root: string;
  options: DoctorRunOptions;
  config: DoctorConfig;
  registry: RuleRegistry;
  project: ProjectInfo;
  files: ScanFileEntry[];
  handles: SourceFileHandle[];
  facts: FileFacts[];
  graph?: WorkspaceGraph;
  diagnostics: Diagnostic[];
  suppressedDiagnostics: Diagnostic[];
  cache: RuleCache;
  helpers: DoctorHelpers;
  enabledRules: DoctorRule[];
  ruleConfigs: Map<string, ResolvedRuleConfig>;
  timings: Record<string, number>;
  phases: Record<string, number>;
}

interface ResolvedRuleConfig {
  enabled: boolean;
  severity?: DoctorSeverity;
  options?: unknown;
}

interface MutableRuleContext extends RuleContext {
  setFile(file: SourceFileHandle): void;
}

export async function runDoctor(options: DoctorRunOptions = {}): Promise<DoctorRunResult> {
  const session = await createScanSession(options);
  await runPhase(session, "parseFileFacts", () => parseSourceFiles(session));
  await runPhase(session, "fileRules", () => runFileRules(session));
  await runPhase(session, "manifestRules", () => runManifestRules(session));
  await runPhase(session, "workspaceGraph", () => buildGraphPhase(session));
  await runPhase(session, "graphRules", () => runGraphRules(session));
  await runPhase(session, "typeGraph", () => buildTypeGraphPhase(session));
  await runPhase(session, "typeRules", () => runTypeRules(session));
  await runPhase(session, "duplication", () => runDuplicationPhase(session));
  await runPhase(session, "health", () => runHealthPhase(session));
  await runPhase(session, "fixPlanning", () => applyRequestedFixes(session));
  applyPolicyFilters(session);

  const started = performance.now();
  const result = createResult(
    session.project,
    session.root,
    session.diagnostics,
    session.suppressedDiagnostics,
    session.config,
    options.profile ? session.timings : undefined,
    options.profile ? session.phases : undefined,
    session.graph,
  );
  markSession(session, "score", started);
  return result;
}

async function createScanSession(options: DoctorRunOptions): Promise<ScanSession> {
  const root = resolve(options.root ?? process.cwd());
  const timings: Record<string, number> = {};
  const phases: Record<string, number> = {};

  let started = performance.now();
  const config = options.config
    ? ((
        await loadConfig<DoctorConfig>({
          cwd: root,
          name: "doctor",
          configFile: "doctor.config",
          dotenv: false,
          globalRc: false,
        })
      ).config ?? {})
    : {};
  const sessionBase = { root, options, config, timings };
  markSession(sessionBase, "config", started);

  started = performance.now();
  const project = await detectProject(root, options.framework ?? "auto");
  const plugins = [...(config.plugins ?? []), ...(options.plugins ?? [])];
  const registry = await collectRulePacks(plugins, project);
  const ruleConfigs = resolveRuleConfigs(config);
  const enabledRules = selectRules(registry, ruleConfigs, options, project);
  markSession(sessionBase, "project", started);

  started = performance.now();
  const files = await selectScanFiles(root, config, options, project);
  markSession(sessionBase, "files", started);

  const helpers = createHelpers();
  return {
    ...sessionBase,
    registry,
    project,
    files,
    handles: [],
    facts: [],
    diagnostics: [],
    suppressedDiagnostics: [],
    cache: options.cache === false ? new MemoryRuleCache() : new PersistentRuleCache(root, config),
    helpers,
    enabledRules,
    ruleConfigs,
    phases,
  };
}

async function parseSourceFiles(session: ScanSession): Promise<void> {
  const started = performance.now();
  let fileId = 0;
  for (const file of session.files) {
    const handle = parseSourceFile(session, file, fileId++);
    session.handles.push(handle);
    if (handle.facts) session.facts.push(handle.facts);
  }
  markSession(session, "parse", started);
}

function parseSourceFile(
  session: ScanSession,
  file: ScanFileEntry,
  fileId: number,
): SourceFileHandle {
  const absolute = file.path;
  const text = readFileSync(absolute, "utf8");
  const hash = sha256(text);
  const cacheKey = createCacheKey(session, "fileFacts", `${absolute}:${hash}`);
  const cachedFacts = session.cache.get<FileFacts>(cacheKey);
  const isVueSfc = absolute.endsWith(".vue");
  const sfc = isVueSfc ? parseSfcFile(absolute, text, hash) : undefined;
  const script = isVueSfc ? createVueScriptForParsing(sfc?.descriptor as any, text) : undefined;
  const scriptText = script?.text ?? text;
  const scriptAst = scriptText.trim() ? parseScript(absolute, scriptText, script?.lang) : null;
  const templateAst = isVueSfc ? parseTemplate(absolute, text) : null;
  const facts =
    cachedFacts && cachedFacts.fileHash === hash
      ? { ...cachedFacts, fileId }
      : createFileFacts(session, file, fileId, text, hash, scriptAst, templateAst, sfc);
  session.cache.set(cacheKey, facts);
  return {
    path: absolute,
    relativePath: file.displayPath,
    sourceKind: file.sourceKind,
    moduleName: file.moduleName,
    text,
    hash,
    isVueSfc,
    scriptAst,
    templateAst,
    sfc,
    facts,
    project: session.project,
    matches(pattern) {
      return nativeMatch(this.relativePath, pattern);
    },
    inAppDir(dir) {
      const appDir = session.project.nuxt?.appDir
        ? relative(session.root, session.project.nuxt.appDir)
        : "app";
      return this.relativePath.startsWith(`${appDir}/${dir}/`);
    },
    isModuleSource() {
      return this.sourceKind === "module";
    },
  };
}

function createFileFacts(
  session: ScanSession,
  file: ScanFileEntry,
  fileId: number,
  text: string,
  hash: string,
  scriptAst: Record<string, unknown> | null,
  templateAst: Record<string, unknown> | null,
  sfc: SourceFileHandle["sfc"],
): FileFacts {
  const imports: ImportFact[] = [];
  const exports: ExportFact[] = [];
  const dynamicImports: DynamicImportFact[] = [];
  const calls: Array<{ name: string; range?: ReturnType<DoctorHelpers["rangeFromOffsets"]> }> = [];
  const macros: Array<{ name: string; range?: ReturnType<DoctorHelpers["rangeFromOffsets"]> }> = [];
  const templateRefs: TemplateFact[] = [];

  if (scriptAst) {
    walkAstFacts(scriptAst, (node: any) => {
      if (node.type === "ImportDeclaration") {
        imports.push({
          source: String(node.source?.value ?? ""),
          specifiers: (node.specifiers ?? []).map((specifier: any) =>
            String(specifier.local?.name ?? specifier.imported?.name ?? "default"),
          ),
          kind: node.importKind === "type" ? "type" : "value",
          range: nodeRange(session, file.path, text, node),
        });
      } else if (node.type === "ExportNamedDeclaration") {
        const source = node.source?.value ? String(node.source.value) : undefined;
        for (const specifier of node.specifiers ?? []) {
          exports.push({
            name: String(specifier.exported?.name ?? specifier.local?.name ?? "unknown"),
            localName: specifier.local?.name,
            source,
            kind: node.exportKind === "type" ? "type" : "value",
            range: nodeRange(session, file.path, text, specifier),
          });
        }
        if (node.declaration)
          collectDeclarationExports(session, file.path, text, node.declaration, exports);
      } else if (node.type === "ExportDefaultDeclaration") {
        exports.push({
          name: "default",
          kind: "value",
          range: nodeRange(session, file.path, text, node),
        });
      } else if (node.type === "ExportAllDeclaration") {
        exports.push({
          name: "*",
          kind: node.exportKind === "type" ? "type" : "value",
          source: String(node.source?.value ?? ""),
          range: nodeRange(session, file.path, text, node),
        });
      } else if (node.type === "CallExpression") {
        const name = getCalleeName(node);
        if (name) {
          const fact = { name, range: nodeRange(session, file.path, text, node) };
          calls.push(fact);
          if (
            /^(defineProps|defineEmits|defineModel|defineExpose|defineOptions|withDefaults)$/.test(
              name,
            )
          )
            macros.push(fact);
        }
        if (name === "import") {
          dynamicImports.push({
            source: typeof node.arguments?.[0]?.value === "string" ? node.arguments[0].value : null,
            range: nodeRange(session, file.path, text, node),
          });
        }
      }
    });
  }

  if (templateAst) {
    walkTemplateFacts(templateAst, (node: any) => {
      if (node.type !== "VAttribute" && node.type !== "VDirective") return;
      const name = node.key?.name?.name ?? node.key?.name;
      if (name === "ref" || name === "key") {
        templateRefs.push({
          name,
          value: node.value?.value,
          range: nodeRange(session, file.path, text, node),
        });
      }
    });
  }

  return {
    fileId,
    path: file.path,
    relativePath: file.displayPath,
    sourceKind: file.sourceKind,
    moduleName: file.moduleName,
    lang: detectLang(file.path),
    fileHash: hash,
    sfc: sfc?.blockHashes,
    imports,
    exports,
    dynamicImports,
    calls,
    templateRefs,
    macros,
    complexity: computeComplexity(text, scriptAst),
    tokens: createTokenFacts(text),
    diagnosticsHints: [],
  };
}

function collectDeclarationExports(
  session: ScanSession,
  file: string,
  text: string,
  node: any,
  exports: ExportFact[],
) {
  if (!node || typeof node !== "object") return;
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    if (node.id?.name)
      exports.push({
        name: node.id.name,
        localName: node.id.name,
        kind: "value",
        range: nodeRange(session, file, text, node),
      });
  } else if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations ?? []) {
      if (declaration.id?.name)
        exports.push({
          name: declaration.id.name,
          localName: declaration.id.name,
          kind: node.kind === "type" ? "type" : "value",
          range: nodeRange(session, file, text, declaration),
        });
    }
  } else if (node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") {
    if (node.id?.name)
      exports.push({
        name: node.id.name,
        localName: node.id.name,
        kind: "type",
        range: nodeRange(session, file, text, node),
      });
  }
}

async function runFileRules(session: ScanSession): Promise<void> {
  if (session.options.analyses && !session.options.rules) return;
  const started = performance.now();
  for (const rule of session.enabledRules) {
    if ((rule.meta.execution ?? "file") !== "file") continue;
    for (const file of session.handles) {
      if (!canRunRuleOnFile(rule, file, session.options)) continue;
      const visitor = await rule.create(createRuleContext(session, file, rule));
      if (!visitor) continue;
      await runVisitor(visitor, file);
    }
  }
  markSession(session, "fileRules", started);
}

async function runManifestRules(session: ScanSession): Promise<void> {
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

async function buildGraphPhase(session: ScanSession): Promise<void> {
  session.graph = buildWorkspaceGraph(session);
}

async function runGraphRules(session: ScanSession): Promise<void> {
  if (!session.graph) return;
  runStructuralGraphRules(session, session.graph);
}

async function buildTypeGraphPhase(session: ScanSession): Promise<void> {
  if (!session.options.types) return;
  session.timings.typeGraphStatus = 0;
}

async function runTypeRules(_session: ScanSession): Promise<void> {}

async function runDuplicationPhase(session: ScanSession): Promise<void> {
  runDuplicationRules(session);
}

async function runHealthPhase(session: ScanSession): Promise<void> {
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
    report(diagnostic) {
      const diagnosticConfig = resolvedConfigFor(session, diagnostic.ruleId);
      if (diagnosticConfig.enabled === false) return;
      const severity =
        diagnosticConfig.severity ??
        currentRuleConfig.severity ??
        diagnostic.severity ??
        rule.meta.severity;
      const next = {
        ...diagnostic,
        severity,
        confidence: diagnostic.confidence ?? defaultConfidenceForPhase(phase),
        evidence: diagnostic.evidence ?? [
          { kind: evidenceKindForPhase(phase), summary: `${phase} analysis` },
        ],
        analysisPhase: diagnostic.analysisPhase ?? phase,
        fingerprint:
          diagnostic.fingerprint ?? createDiagnosticFingerprint(session.root, diagnostic, file),
      };
      session.diagnostics.push(next);
    },
    getFileText(target) {
      return readFileSync(resolve(session.root, target), "utf8");
    },
    getJson<T = unknown>(target: string): T | null {
      try {
        return JSON.parse(readFileSync(resolve(session.root, target), "utf8")) as T;
      } catch {
        return null;
      }
    },
    cache: session.cache,
    helpers: session.helpers,
    range(nodeOrStart, end) {
      if (!nodeOrStart) return undefined;
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

function canRunRuleOnFile(
  rule: DoctorRule,
  file: SourceFileHandle,
  options: DoctorRunOptions,
): boolean {
  if (rule.meta.sourceKinds && !rule.meta.sourceKinds.includes(file.sourceKind)) return false;
  const requires = rule.meta.requires;
  if (!requires) return true;
  if (requires.sfc && !file.sfc) return false;
  if (requires.template && !file.templateAst) return false;
  if (requires.script && !file.scriptAst) return false;
  if (requires.types && !options.types) return false;
  return true;
}

function applyRequestedFixes(session: ScanSession): void {
  if (!session.options.fix && !session.options.unsafeFix && !session.options.structuralReview)
    return;
  const started = performance.now();
  applyFixes(session.diagnostics, {
    includeUnsafe: session.options.unsafeFix,
    includeStructuralReview: session.options.structuralReview,
  });
  markSession(session, "fix", started);
}

function applyPolicyFilters(session: ScanSession): void {
  applySeverityFilter(session);
  const result = applyDiagnosticPolicy(session);
  session.diagnostics = result.diagnostics;
  session.suppressedDiagnostics = result.suppressedDiagnostics;
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

function markSession(
  session: { options: DoctorRunOptions; timings: Record<string, number> },
  name: string,
  start: number,
): void {
  if (session.options.profile) session.timings[name] = Math.round(performance.now() - start);
}

export function cleanCache(root = process.cwd(), config?: DoctorConfig): void {
  const dir = resolve(root, config?.cache?.dir ?? ".vue-doctor/cache");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

async function collectRulePacks(
  plugins: DoctorPlugin[],
  project: ProjectInfo,
): Promise<{ packs: RulePack[]; rules: DoctorRule[] }> {
  const registeredPacks: RulePack[] = [];
  for (const plugin of plugins) {
    await plugin.setup?.({
      registerRulePack(pack) {
        registeredPacks.push(pack);
      },
      registerReporter() {},
      registerProjectDetector() {},
      registerNuxtManifestContributor() {},
    });
  }
  const packs = [...plugins.flatMap((plugin) => plugin.rulePacks ?? []), ...registeredPacks].filter(
    (pack) => isActivePack(pack, project),
  );
  return { packs, rules: packs.flatMap((pack) => pack.rules) };
}

function isActivePack(pack: RulePack, project: ProjectInfo): boolean {
  if (!pack.activation) return true;
  if (pack.activation.nuxt && project.framework !== "nuxt") return false;
  const hasPackageOrModuleConstraints = Boolean(
    pack.activation.packages?.length || pack.activation.modules?.length,
  );
  if (!hasPackageOrModuleConstraints) return true;
  const moduleNames = new Set((project.nuxt?.modules ?? []).map((module) => module.name));
  return Boolean(
    pack.activation.packages?.some((name) => moduleNames.has(name)) ||
    pack.activation.modules?.some((name) => moduleNames.has(name)),
  );
}

function selectRules(
  registry: RuleRegistry,
  ruleConfigs: Map<string, ResolvedRuleConfig>,
  options: DoctorRunOptions,
  project: ProjectInfo,
): DoctorRule[] {
  const wanted = options.rules
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const presetRules = new Set<string>();
  if (options.preset) {
    for (const pack of registry.packs) {
      const preset = pack.presets?.[options.preset];
      if (!preset) {
        for (const rule of pack.rules) presetRules.add(rule.meta.id);
        continue;
      }
      for (const ruleId of preset) presetRules.add(ruleId);
    }
  }

  return registry.rules
    .filter((rule) => !options.preset || presetRules.has(rule.meta.id))
    .filter((rule) => !rule.meta.requires?.nuxt || project.framework === "nuxt")
    .filter((rule) => !rule.meta.requires?.types || options.types)
    .filter((rule) => supportsFrameworkVersion(rule, project))
    .filter(
      (rule) => !wanted?.length || wanted.some((pattern) => nativeMatch(rule.meta.id, pattern)),
    )
    .filter((rule) => resolvedConfig(ruleConfigs, rule.meta.id).enabled);
}

function resolveRuleConfigs(config: DoctorConfig): Map<string, ResolvedRuleConfig> {
  const resolved = new Map<string, ResolvedRuleConfig>();
  for (const [ruleId, value] of Object.entries(config.rules ?? {})) {
    if (value === "off") {
      resolved.set(ruleId, { enabled: false });
      continue;
    }
    if (isSeverity(value)) {
      resolved.set(ruleId, { enabled: true, severity: value });
      continue;
    }
    if (Array.isArray(value)) {
      const [severity, options] = value;
      if (!isSeverity(severity))
        throw new Error(`Invalid severity for rule "${ruleId}": ${String(severity)}`);
      resolved.set(ruleId, { enabled: true, severity, options });
      continue;
    }
    throw new Error(`Invalid config for rule "${ruleId}".`);
  }
  return resolved;
}

function resolvedConfigFor(session: ScanSession, ruleId: string): ResolvedRuleConfig {
  return resolvedConfig(session.ruleConfigs, ruleId);
}

function resolvedConfig(
  ruleConfigs: Map<string, ResolvedRuleConfig>,
  ruleId: string,
): ResolvedRuleConfig {
  return ruleConfigs.get(ruleId) ?? { enabled: true };
}

function isSeverity(value: unknown): value is DoctorSeverity {
  return value === "blocker" || value === "error" || value === "warn" || value === "info";
}

function supportsFrameworkVersion(rule: DoctorRule, project: ProjectInfo): boolean {
  const vue = rule.meta.frameworkVersions?.vue;
  if (vue && !satisfiesVersion(project.vueVersion, vue)) return false;
  const nuxt = rule.meta.frameworkVersions?.nuxt;
  if (nuxt && !project.nuxtVersion) return false;
  if (nuxt && project.nuxtVersion && !satisfiesVersion(project.nuxtVersion, nuxt)) return false;
  return true;
}

function satisfiesVersion(version: string, range: string): boolean {
  const match = range.trim().match(/^(>=|>|<=|<|=)?\s*(\d+(?:\.\d+){0,2})/);
  if (!match) return true;
  const operator = match[1] ?? "=";
  const comparison = compareVersions(version, match[2]);
  if (operator === ">=") return comparison >= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === "<") return comparison < 0;
  return comparison === 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (let index = 0; index < 3; index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function numericVersionParts(version: string): number[] {
  return version
    .replace(/^[^\d]*/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function applyFixes(
  diagnostics: Diagnostic[],
  options: { includeUnsafe?: boolean; includeStructuralReview?: boolean } = {},
) {
  const byFile = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.fix) continue;
    if (diagnostic.fix.kind === "suggestion") continue;
    if (diagnostic.fix.kind === "unsafe" && !options.includeUnsafe) continue;
    if (diagnostic.fix.kind === "structural-review" && !options.includeStructuralReview) continue;
    const list = byFile.get(diagnostic.file) ?? [];
    list.push(diagnostic);
    byFile.set(diagnostic.file, list);
  }
  for (const [file, items] of byFile) {
    const text = readFileSync(file, "utf8");
    const ms = new MagicString(text);
    const edits = planNonOverlappingFixes(items).sort((a, b) => b.range.start - a.range.start);
    for (const edit of edits) ms.overwrite(edit.range.start, edit.range.end, edit.text);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ms.toString());
  }
}

function createResult(
  project: ProjectInfo,
  root: string,
  diagnostics: Diagnostic[],
  suppressedDiagnostics: Diagnostic[],
  config: DoctorConfig,
  timings?: Record<string, number>,
  phases?: Record<string, number>,
  graph?: WorkspaceGraph,
): DoctorRunResult {
  const weights = { ...DEFAULT_WEIGHTS, ...config.score?.weights };
  const summary = {
    blocker: diagnostics.filter((d) => d.severity === "blocker").length,
    error: diagnostics.filter((d) => d.severity === "error").length,
    warn: diagnostics.filter((d) => d.severity === "warn").length,
    info: diagnostics.filter((d) => d.severity === "info").length,
    fixable: diagnostics.filter((d) => d.fix?.kind === "safe").length,
  };
  const blockerPenalty = Math.min(100, summary.blocker * weights.blocker);
  const errorPenalty = Math.min(summary.blocker ? 100 : 60, summary.error * weights.error);
  const warnPenalty = Math.min(
    summary.error || summary.blocker ? 30 : 25,
    summary.warn * weights.warn,
  );
  const infoPenalty = Math.min(10, summary.info * weights.info);
  const penalty = Math.min(100, blockerPenalty + errorPenalty + warnPenalty + infoPenalty);
  const categories: Record<string, Diagnostic[]> = {};
  for (const diagnostic of diagnostics) {
    categories[diagnostic.category] ??= [];
    categories[diagnostic.category].push(diagnostic);
  }
  const categoryScores = Object.fromEntries(
    Object.entries(categories).map(([category, items]) => {
      const categorySummary = {
        blocker: items.filter((d) => d.severity === "blocker").length,
        error: items.filter((d) => d.severity === "error").length,
        warn: items.filter((d) => d.severity === "warn").length,
        info: items.filter((d) => d.severity === "info").length,
      };
      const categoryPenalty = Math.min(
        100,
        Math.min(100, categorySummary.blocker * weights.blocker) +
          Math.min(categorySummary.blocker ? 100 : 60, categorySummary.error * weights.error) +
          Math.min(
            categorySummary.error || categorySummary.blocker ? 30 : 25,
            categorySummary.warn * weights.warn,
          ) +
          Math.min(10, categorySummary.info * weights.info),
      );
      return [category, Math.max(0, 100 - categoryPenalty)];
    }),
  );
  return {
    version: VERSION,
    reportVersion: 2,
    framework: project.framework,
    root,
    score: Math.max(0, 100 - penalty),
    categoryScores,
    summary,
    diagnostics,
    suppressedDiagnostics,
    timings,
    phases,
    graph: graph
      ? {
          files: graph.files.size,
          importEdges: graph.importEdges.length,
          exportEdges: graph.exportEdges.length,
          virtualRoots: graph.virtualRoots.length,
          cycles: graph.sccs.filter((scc) => scc.length > 1).length,
        }
      : undefined,
    project,
  };
}

function createDiagnosticFingerprint(
  root: string,
  diagnostic: Diagnostic,
  file: SourceFileHandle,
): string {
  const rel = relative(root, diagnostic.file);
  const anchor = nearestAnchor(file.text, diagnostic.range?.start ?? 0);
  const message = diagnostic.message.replace(/\s+/g, " ").replace(/['"`][^'"`]+['"`]/g, '""');
  return sha256(`${diagnostic.ruleId}:${rel}:${anchor}:${message}`);
}

function buildWorkspaceGraph(session: ScanSession): WorkspaceGraph {
  const files = new Map(session.facts.map((fact) => [fact.fileId, fact]));
  const fileIdsByPath = new Map(session.facts.map((fact) => [fact.path, fact.fileId]));
  const byRelativePath = new Map(session.facts.map((fact) => [fact.relativePath, fact.fileId]));
  const importEdges: GraphEdge[] = [];
  const exportEdges: GraphEdge[] = [];
  const importersByFile = new Map<number, number[]>();
  const exportsByName = new Map<string, ExportFact[]>();
  const refsByExport = new Map<string, Array<{ fileId: number; range?: Diagnostic["range"] }>>();

  for (const fact of session.facts) {
    for (const item of fact.exports) {
      exportEdges.push({
        from: fact.fileId,
        to: item.source
          ? resolveImportTarget(session, fact, item.source, byRelativePath)
          : undefined,
        specifier: item.source,
        kind: item.source ? "re-export" : "export",
      });
      const exports = exportsByName.get(item.name) ?? [];
      exports.push(item);
      exportsByName.set(item.name, exports);
    }
    for (const item of fact.imports) {
      const target = resolveImportTarget(session, fact, item.source, byRelativePath);
      importEdges.push({
        from: fact.fileId,
        to: target,
        specifier: item.source,
        kind: item.kind === "type" ? "type-import" : "import",
      });
      if (target !== undefined) {
        const importers = importersByFile.get(target) ?? [];
        importers.push(fact.fileId);
        importersByFile.set(target, importers);
      }
      for (const specifier of item.specifiers) {
        const refs = refsByExport.get(specifier) ?? [];
        refs.push({ fileId: fact.fileId, range: item.range });
        refsByExport.set(specifier, refs);
      }
    }
    for (const item of fact.calls) {
      const refs = refsByExport.get(item.name) ?? [];
      refs.push({ fileId: fact.fileId, range: item.range });
      refsByExport.set(item.name, refs);
    }
  }

  const virtualRoots = createVirtualRoots(session, fileIdsByPath);
  for (const root of virtualRoots) {
    if (root.fileId === undefined) continue;
    importEdges.push({
      from: root.fileId,
      to: root.fileId,
      kind: "virtual-root",
      specifier: root.id,
    });
  }

  return {
    files,
    fileIdsByPath,
    importEdges,
    exportEdges,
    virtualRoots,
    reverseIndex: { importersByFile, refsByExport, exportsByName },
    sccs: computeSccs(
      session.facts.map((fact) => fact.fileId),
      importEdges,
    ),
  };
}

function createVirtualRoots(
  session: ScanSession,
  fileIdsByPath: Map<string, number>,
): VirtualRootNode[] {
  const roots: VirtualRootNode[] = [];
  const addRoot = (kind: VirtualRootNode["kind"], file: string | undefined, evidence: string) => {
    if (!file) return;
    const absolute = resolve(session.root, file);
    roots.push({
      id: `${kind}:${absolute}`,
      kind,
      file: absolute,
      fileId: fileIdsByPath.get(absolute),
      evidence,
    });
  };

  addRoot("package", "package.json", "package metadata");
  for (const file of readPackageDeps(session.root).entryFiles) {
    roots.push({
      id: `package-entry:${file}`,
      kind: "package",
      file,
      fileId: fileIdsByPath.get(file),
      evidence: "package entrypoint",
    });
  }
  for (const fact of session.facts) {
    if (
      /(^|\/)(app\.vue|main\.[cm]?[jt]sx?|index\.[cm]?[jt]sx?)$/.test(fact.relativePath) ||
      /(^|\/)app\/error\.vue$/.test(fact.relativePath) ||
      /(^|\/)(pages|layouts|middleware|plugins|components|server\/(?:api|routes|middleware|plugins|utils))\//.test(
        fact.relativePath,
      ) ||
      /(^|\/)src\/runtime\//.test(fact.relativePath) ||
      /(^|\/)composables\/[^/]+\.[cm]?[jt]s$/.test(fact.relativePath) ||
      /(^|\/)content\/.+\.mdc?$/.test(fact.relativePath)
    ) {
      roots.push({
        id: `convention:${fact.relativePath}`,
        kind:
          fact.relativePath.includes("/server/") || fact.relativePath.startsWith("server/")
            ? "nuxt-server"
            : "config",
        file: fact.path,
        fileId: fact.fileId,
        evidence: "filesystem convention",
      });
    }
  }

  const manifest = session.project.nuxt?.manifest;
  for (const page of manifest?.pages ?? []) addRoot("nuxt-page", page.file, "Nuxt manifest page");
  for (const plugin of manifest?.pluginFiles ?? [])
    addRoot("nuxt-plugin", plugin, "Nuxt manifest plugin");
  for (const handler of [
    ...(session.project.nuxt?.serverDirs.api ?? []),
    ...(session.project.nuxt?.serverDirs.routes ?? []),
    ...(session.project.nuxt?.serverDirs.middleware ?? []),
    ...(session.project.nuxt?.serverDirs.plugins ?? []),
  ])
    addRoot("nuxt-server", handler, "Nuxt server handler");
  for (const component of session.project.nuxt?.components.values() ?? [])
    addRoot("nuxt-component", component.file, "Nuxt manifest component");
  for (const source of session.project.nuxt?.moduleSources ?? [])
    addRoot("nuxt-module", source.root, `Nuxt module source ${source.module}`);
  return roots;
}

function resolveImportTarget(
  session: ScanSession,
  from: FileFacts,
  specifier: string,
  byRelativePath: Map<string, number>,
): number | undefined {
  if (
    !specifier.startsWith(".") &&
    !specifier.startsWith("~/") &&
    !specifier.startsWith("@/") &&
    !specifier.startsWith("~~/")
  )
    return undefined;
  const bases = specifier.startsWith("~~/")
    ? rootAliasImportBases(session, specifier.slice(3))
    : specifier.startsWith("~/") || specifier.startsWith("@/")
      ? aliasImportBases(session, specifier.slice(2))
      : [relative(session.root, resolve(dirname(from.path), specifier))];
  for (const candidate of bases.flatMap((base) => importCandidates(base))) {
    const match = byRelativePath.get(candidate);
    if (match !== undefined) return match;
  }
  return undefined;
}

function aliasImportBases(session: ScanSession, base: string): string[] {
  const roots = new Set(["", "app", "shared"]);
  for (const root of session.project.nuxt?.manifest?.appScanRoots ?? []) {
    roots.add(relative(session.root, root));
  }
  for (const fact of session.facts) {
    const appIndex = fact.relativePath.indexOf("/app/");
    if (appIndex > 0) {
      const prefix = fact.relativePath.slice(0, appIndex);
      roots.add(`${prefix}/app`);
      roots.add(`${prefix}/shared`);
    }
  }
  return [...roots].flatMap((root) => (root ? [`${root}/${base}`] : [base]));
}

function rootAliasImportBases(session: ScanSession, base: string): string[] {
  const roots = new Set(["", ...workspacePackageRoots(session)]);
  const bases: string[] = [];
  for (const root of roots) {
    bases.push(root ? `${root}/${base}` : base);
    if (base.startsWith("server/")) {
      const withoutServer = base.slice("server/".length);
      bases.push(root ? `${root}/${withoutServer}` : withoutServer);
    }
  }
  return bases;
}

function workspacePackageRoots(session: ScanSession): string[] {
  const roots = new Set<string>();
  for (const fact of session.facts) {
    const segments = fact.relativePath.split("/");
    if (segments[0] === "apps" && segments[1]) roots.add(`apps/${segments[1]}`);
    const appIndex = fact.relativePath.indexOf("/app/");
    if (appIndex > 0) roots.add(fact.relativePath.slice(0, appIndex));
    if (/(^|\/)nuxt\.config\.[cm]?[jt]s$/.test(fact.relativePath)) {
      const root = dirname(fact.relativePath);
      if (root !== ".") roots.add(root);
    }
  }
  return [...roots];
}

function importCandidates(base: string): string[] {
  const clean = base.replace(/^\.\//, "");
  const exts = [
    "",
    ".ts",
    ".tsx",
    ".d.ts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".vue",
    "/index.ts",
    "/index.d.ts",
    "/index.js",
    "/index.json",
    "/index.vue",
  ];
  return exts.map((ext) => `${clean}${ext}`);
}

function runStructuralGraphRules(session: ScanSession, graph: WorkspaceGraph) {
  const analyses = selectedAnalyses(session);
  if (analyses.has("dead-code")) runDeadCodeRules(session, graph);
  if (analyses.has("graph")) runCycleAndDuplicateExportRules(session, graph);
}

function runDeadCodeRules(session: ScanSession, graph: WorkspaceGraph) {
  const live = reachableFiles(graph);
  const packageDeps = readPackageDeps(session.root);
  const importedPackages = new Set<string>();

  for (const fact of session.facts) {
    for (const item of fact.imports) {
      if (
        !item.source.startsWith(".") &&
        !item.source.startsWith("~/") &&
        !item.source.startsWith("@/") &&
        !item.source.startsWith("~~/")
      )
        importedPackages.add(packageNameFromSpecifier(item.source));
      if (
        isLocalSpecifier(item.source) &&
        !isGeneratedOrAssetImport(item.source) &&
        !isLikelyForeignFrameworkFile(session, fact.relativePath, packageDeps) &&
        resolveImportTarget(
          session,
          fact,
          item.source,
          new Map(session.facts.map((f) => [f.relativePath, f.fileId])),
        ) === undefined
      ) {
        pushDiagnostic(session, {
          ruleId: "workspace/dead-code/unresolved-import",
          severity: "error",
          category: "dead-code",
          message: `Import "${item.source}" could not be resolved.`,
          file: fact.path,
          range: item.range,
          confidence: "proven",
          evidence: [{ kind: "graph", summary: "No matching file node exists for this import." }],
          analysisPhase: "graph",
        });
      }
    }
  }

  for (const fact of session.facts) {
    if (
      !live.has(fact.fileId) &&
      !isLikelyTestOrConfig(fact.relativePath) &&
      !isLikelyForeignFrameworkFile(session, fact.relativePath, packageDeps) &&
      !isTypeSurfaceFile(fact.relativePath)
    ) {
      pushDiagnostic(session, {
        ruleId: "workspace/dead-code/unused-file",
        severity: "info",
        category: "dead-code",
        message: "File is not reachable from known package, framework, or manifest roots.",
        file: fact.path,
        confidence: "manifest-backed",
        evidence: [{ kind: "graph", summary: "No reachability path from virtual roots." }],
        analysisPhase: "graph",
      });
    }
    for (const exp of fact.exports) {
      if (exp.name === "default" || exp.name === "*") continue;
      if (
        !graph.reverseIndex.refsByExport.has(exp.name) &&
        !live.has(fact.fileId) &&
        !isLikelyForeignFrameworkFile(session, fact.relativePath, packageDeps) &&
        !isTypeSurfaceFile(fact.relativePath)
      ) {
        pushDiagnostic(session, {
          ruleId:
            exp.kind === "type"
              ? "workspace/dead-code/unused-type-export"
              : "workspace/dead-code/unused-export",
          severity: "info",
          category: "dead-code",
          message: `Export "${exp.name}" is not referenced by known imports or framework roots.`,
          file: fact.path,
          range: exp.range,
          confidence: exp.kind === "type" ? "type-backed" : "proven",
          evidence: [{ kind: "graph", summary: "Export name has no reverse references." }],
          analysisPhase: "graph",
        });
      }
    }
  }

  for (const dep of packageDeps.runtime) {
    if (!importedPackages.has(dep) && !isIgnoredDependencyForUnusedReport(dep)) {
      pushDiagnostic(session, {
        ruleId: "workspace/dead-code/unused-dependency",
        severity: "info",
        category: "dead-code",
        message: `Dependency "${dep}" is declared but was not imported by scanned source files.`,
        file: resolve(session.root, "package.json"),
        confidence: "heuristic-medium",
        evidence: [{ kind: "graph", summary: "No import specifier matched this package." }],
        analysisPhase: "graph",
      });
    }
  }

  for (const dep of importedPackages) {
    if (
      !packageDeps.all.has(dep) &&
      !isNodeBuiltin(dep) &&
      !dep.startsWith("#") &&
      !isIgnoredDependencyForUnusedReport(dep)
    ) {
      pushDiagnostic(session, {
        ruleId: "workspace/dead-code/unlisted-dependency",
        severity: "warn",
        category: "dead-code",
        message: `Package "${dep}" is imported but is not listed in package.json dependencies.`,
        file: resolve(session.root, "package.json"),
        confidence: "proven",
        evidence: [{ kind: "graph", summary: "Import graph references an undeclared package." }],
        analysisPhase: "graph",
      });
    }
  }
}

function runCycleAndDuplicateExportRules(session: ScanSession, graph: WorkspaceGraph) {
  for (const scc of graph.sccs.filter((item) => item.length > 1)) {
    const files = scc.map((id) => graph.files.get(id)?.path).filter(Boolean) as string[];
    pushDiagnostic(session, {
      ruleId: "workspace/dead-code/circular-dependency",
      severity: "warn",
      category: "architecture",
      message: `Circular dependency detected across ${files.length} files.`,
      file: files[0]!,
      related: files.slice(1).map((file) => ({ file, message: "Cycle member" })),
      confidence: "proven",
      evidence: [{ kind: "graph", summary: "Strongly connected component in import graph." }],
      analysisPhase: "graph",
    });
  }
  for (const [name, exports] of graph.reverseIndex.exportsByName) {
    const files = [
      ...new Set(exports.map((item) => findExportFile(graph, item)).filter(Boolean)),
    ] as string[];
    if (name === "default" || name === "*" || files.length < 2) continue;
    pushDiagnostic(session, {
      ruleId: "workspace/dead-code/duplicate-export",
      severity: "warn",
      category: "architecture",
      message: `Export name "${name}" appears in multiple files.`,
      file: files[0]!,
      related: files.slice(1).map((file) => ({ file, message: `Also exports "${name}"` })),
      confidence: "proven",
      evidence: [{ kind: "graph", summary: "Workspace export index contains multiple owners." }],
      analysisPhase: "graph",
    });
  }
}

function runDuplicationRules(session: ScanSession) {
  if (!selectedAnalyses(session).has("dupes")) return;
  const byHash = new Map<string, FileFacts[]>();
  for (const fact of session.facts) {
    for (const hash of new Set(fact.tokens.hashes)) {
      const list = byHash.get(hash) ?? [];
      list.push(fact);
      byHash.set(hash, list);
    }
  }
  for (const [hash, facts] of byHash) {
    const files = [...new Set(facts.map((fact) => fact.path))];
    if (files.length < 2) continue;
    pushDiagnostic(session, {
      ruleId: "workspace/duplication/exact-clone",
      severity: "info",
      category: "duplication",
      message: `Repeated token window detected in ${files.length} files.`,
      file: files[0]!,
      related: files.slice(1).map((file) => ({ file, message: `Clone fingerprint ${hash}` })),
      confidence: "heuristic-high",
      evidence: [{ kind: "facts", summary: "Matching normalized token-window hash." }],
      analysisPhase: "duplication",
    });
  }
}

function runHealthRules(session: ScanSession) {
  if (!selectedAnalyses(session).has("health")) return;
  for (const fact of session.facts) {
    if (fact.complexity.cyclomatic >= 15) {
      pushDiagnostic(session, {
        ruleId: "workspace/health/high-cyclomatic-complexity",
        severity: "warn",
        category: "health",
        message: `File has cyclomatic complexity ${fact.complexity.cyclomatic}.`,
        file: fact.path,
        confidence: "heuristic-high",
        evidence: [{ kind: "facts", summary: "Complexity counted from branch syntax." }],
        analysisPhase: "health",
      });
    }
    if (fact.imports.length >= 20) {
      pushDiagnostic(session, {
        ruleId: "workspace/health/high-fan-out",
        severity: "info",
        category: "health",
        message: `File imports ${fact.imports.length} modules.`,
        file: fact.path,
        confidence: "heuristic-high",
        evidence: [{ kind: "graph", summary: "Import fan-out from file facts." }],
        analysisPhase: "health",
      });
    }
  }
}

function nearestAnchor(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const matches = [
    ...before.matchAll(
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|<([A-Z][\w.-]*)\b/g,
    ),
  ];
  const last = matches.at(-1);
  return last ? (last[1] ?? last[2] ?? last[3] ?? "file") : "file";
}

async function runPhase(
  session: ScanSession,
  name: string,
  run: () => Promise<void> | void,
): Promise<void> {
  const started = performance.now();
  await run();
  session.phases[name] = Math.round(performance.now() - started);
}

function pushDiagnostic(session: ScanSession, diagnostic: Diagnostic): void {
  session.diagnostics.push({
    ...diagnostic,
    fingerprint:
      diagnostic.fingerprint ??
      createDiagnosticFingerprint(session.root, diagnostic, {
        path: diagnostic.file,
        relativePath: relative(session.root, diagnostic.file),
        sourceKind: "app",
        text: readFileSyncIfExists(diagnostic.file) ?? "",
        hash: "",
        isVueSfc: false,
        project: session.project,
        matches: () => false,
        inAppDir: () => false,
        isModuleSource: () => false,
      }),
  });
}

function defaultConfidenceForPhase(phase: Diagnostic["analysisPhase"]) {
  if (phase === "graph") return "proven";
  if (phase === "type") return "type-backed";
  if (phase === "manifest") return "manifest-backed";
  if (phase === "duplication" || phase === "health") return "heuristic-high";
  return "heuristic-medium";
}

function evidenceKindForPhase(phase: Diagnostic["analysisPhase"]) {
  if (phase === "file") return "ast";
  if (phase === "manifest") return "manifest";
  if (phase === "graph" || phase === "workspace") return "graph";
  if (phase === "type") return "types";
  if (phase === "duplication" || phase === "health") return "facts";
  return "facts";
}

function selectedAnalyses(session: ScanSession): Set<string> {
  const requested = session.options.analyses
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(requested ?? []);
}

function walkAstFacts(node: unknown, visit: (node: unknown) => void) {
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  visit(typed);
  for (const key of visitorKeys[typed.type] ?? []) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkAstFacts(child, visit);
    } else if (value && typeof value === "object") {
      walkAstFacts(value, visit);
    }
  }
}

function walkTemplateFacts(node: unknown, visit: (node: unknown) => void) {
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  visit(typed);
  for (const key of templateFactKeys(typed.type)) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkTemplateFacts(child, visit);
    } else if (value && typeof value === "object") {
      walkTemplateFacts(value, visit);
    }
  }
}

function templateFactKeys(type: string): string[] {
  if (visitorKeys[type]) return visitorKeys[type];
  switch (type) {
    case "Program":
      return ["body", "templateBody"];
    case "VDocumentFragment":
    case "VElement":
      return ["children", "startTag", "endTag"];
    case "VStartTag":
      return ["attributes"];
    case "VAttribute":
    case "VDirective":
      return ["key", "value"];
    case "VExpressionContainer":
      return ["expression", "references"];
    default:
      return [];
  }
}

function nodeRange(session: ScanSession, file: string, source: string, node: any) {
  const start = node?.start ?? node?.range?.[0];
  const end = node?.end ?? node?.range?.[1] ?? start;
  return typeof start === "number"
    ? session.helpers.rangeFromOffsets(file, source, start, end)
    : undefined;
}

function detectLang(file: string): FileFacts["lang"] {
  if (file.endsWith(".vue")) return "vue";
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) return "ts";
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return "js";
  if (file.endsWith(".mdc")) return "mdc";
  if (file.endsWith(".md")) return "md";
  return "unknown";
}

function computeComplexity(text: string, ast: Record<string, unknown> | null) {
  let cyclomatic = 1;
  let cognitive = 0;
  if (ast) {
    walkAstFacts(ast, (node: any) => {
      if (
        /^(IfStatement|ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement|CatchClause|ConditionalExpression|LogicalExpression|SwitchCase)$/.test(
          node.type,
        )
      ) {
        cyclomatic++;
        cognitive++;
      }
    });
  }
  return { cyclomatic, cognitive, lines: text.split(/\r?\n/).length };
}

function createTokenFacts(text: string) {
  const normalizedTokens = (
    text.match(/[A-Za-z_$][\w$]*|\d+|=>|===|!==|==|!=|[{}()[\].,;:+\-*/%<>]/g) ?? []
  ).map((token) => (/^[A-Za-z_$]/.test(token) ? token : token.replace(/\d+/g, "0")));
  const hashes: string[] = [];
  const window = 30;
  for (let index = 0; index + window <= normalizedTokens.length; index += 10) {
    hashes.push(sha256(normalizedTokens.slice(index, index + window).join(" ")).slice(0, 16));
  }
  return { hashes, normalizedTokens };
}

function reachableFiles(graph: WorkspaceGraph): Set<number> {
  const live = new Set<number>();
  const queue = graph.virtualRoots.flatMap((root) =>
    root.fileId === undefined ? [] : [root.fileId],
  );
  for (const fact of graph.files.values()) {
    if (fact.exports.some((item) => graph.reverseIndex.refsByExport.has(item.name)))
      queue.push(fact.fileId);
  }
  while (queue.length) {
    const id = queue.shift()!;
    if (live.has(id)) continue;
    live.add(id);
    for (const edge of graph.importEdges) {
      if (edge.from === id && edge.to !== undefined && !live.has(edge.to)) queue.push(edge.to);
    }
  }
  return live;
}

function computeSccs(nodes: number[], edges: GraphEdge[]): number[][] {
  const graph = new Map<number, number[]>();
  for (const node of nodes) graph.set(node, []);
  for (const edge of edges) {
    if (edge.to !== undefined && edge.from !== edge.to) graph.get(edge.from)?.push(edge.to);
  }
  let index = 0;
  const stack: number[] = [];
  const onStack = new Set<number>();
  const indices = new Map<number, number>();
  const lowlinks = new Map<number, number>();
  const components: number[][] = [];
  const strongConnect = (node: number) => {
    indices.set(node, index);
    lowlinks.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlinks.set(node, Math.min(lowlinks.get(node)!, lowlinks.get(next)!));
      } else if (onStack.has(next)) {
        lowlinks.set(node, Math.min(lowlinks.get(node)!, indices.get(next)!));
      }
    }
    if (lowlinks.get(node) === indices.get(node)) {
      const component: number[] = [];
      let next: number | undefined;
      do {
        next = stack.pop();
        if (next === undefined) break;
        onStack.delete(next);
        component.push(next);
      } while (next !== node);
      components.push(component);
    }
  };
  for (const node of nodes) if (!indices.has(node)) strongConnect(node);
  return components;
}

interface PackageDependencyFacts {
  all: Set<string>;
  runtime: Set<string>;
  foreignRoots: Set<string>;
  entryFiles: Set<string>;
}

function readPackageDeps(root: string): PackageDependencyFacts {
  const all = new Set<string>();
  const runtime = new Set<string>();
  const foreignRoots = new Set<string>();
  const entryFiles = new Set<string>();
  for (const file of findPackageJsonFiles(root)) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8"));
      const packageRoot = dirname(file);
      for (const dep of Object.keys(json.dependencies ?? {})) {
        all.add(dep);
        runtime.add(dep);
      }
      for (const dep of Object.keys(json.optionalDependencies ?? {})) {
        all.add(dep);
        runtime.add(dep);
      }
      for (const dep of Object.keys(json.devDependencies ?? {})) all.add(dep);
      for (const dep of Object.keys(json.peerDependencies ?? {})) all.add(dep);
      const names = new Set(allPackageNames(json));
      if (
        names.has("next") ||
        names.has("@sveltejs/kit") ||
        names.has("svelte") ||
        names.has("solid-js") ||
        names.has("@solidjs/start") ||
        names.has("@tanstack/start") ||
        names.has("@tanstack/react-start") ||
        names.has("react-router") ||
        names.has("@react-router/dev")
      ) {
        foreignRoots.add(relative(root, packageRoot));
      }
      for (const entry of packageEntryCandidates(root, packageRoot, json)) entryFiles.add(entry);
    } catch {
      continue;
    }
  }
  return { all, runtime, foreignRoots, entryFiles };
}

function findPackageJsonFiles(root: string): string[] {
  const files: string[] = [];
  const ignored = new Set([
    "node_modules",
    ".git",
    ".nuxt",
    ".next",
    ".output",
    "dist",
    "coverage",
  ]);
  const visit = (dir: string, depth: number) => {
    if (depth > 5) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = resolve(dir, entry.name);
      if (entry.isFile() && entry.name === "package.json") files.push(absolute);
      if (entry.isDirectory()) visit(absolute, depth + 1);
    }
  };
  try {
    if (statSync(root).isDirectory()) visit(root, 0);
  } catch {
    return [];
  }
  return files;
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0]!;
}

function isLocalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("~/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~~/")
  );
}

function isNodeBuiltin(name: string): boolean {
  return /^(node:|fs$|path$|url$|crypto$|os$|util$|stream$|events$|buffer$|process$)/.test(name);
}

function isLikelyTestOrConfig(relativePath: string): boolean {
  return /(^|\/)(test|tests|fixtures|__tests__)\/|\.config\.|package\.json$/.test(relativePath);
}

function isGeneratedOrAssetImport(specifier: string): boolean {
  const clean = specifier.split("?")[0] ?? specifier;
  return (
    /(^|\/)(\.nuxt|\.next|generated|dist|coverage)\//.test(clean) ||
    /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|json)$/.test(clean)
  );
}

function allPackageNames(json: Record<string, unknown>): string[] {
  return [
    ...Object.keys((json.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((json.optionalDependencies as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((json.devDependencies as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((json.peerDependencies as Record<string, unknown> | undefined) ?? {}),
  ];
}

function packageEntryCandidates(
  root: string,
  packageRoot: string,
  json: Record<string, unknown>,
): string[] {
  const candidates = new Set<string>();
  for (const value of [json.main, json.module, json.types, json.typings]) {
    if (typeof value !== "string") continue;
    for (const file of sourceCandidatesForPackageEntry(packageRoot, value)) candidates.add(file);
  }
  collectPackageExportEntries(packageRoot, json.exports, candidates);
  for (const standard of ["src/index.ts", "src/module.ts", "src/preview.ts"]) {
    const absolute = resolve(packageRoot, standard);
    if (existsSync(absolute)) candidates.add(absolute);
  }
  return [...candidates].filter((file) => file.startsWith(root));
}

function collectPackageExportEntries(
  packageRoot: string,
  value: unknown,
  candidates: Set<string>,
): void {
  if (typeof value === "string") {
    for (const file of sourceCandidatesForPackageEntry(packageRoot, value)) candidates.add(file);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectPackageExportEntries(packageRoot, item, candidates);
  }
}

function sourceCandidatesForPackageEntry(packageRoot: string, entry: string): string[] {
  if (!entry || entry.startsWith("#")) return [];
  const clean = entry.replace(/^\.\//, "");
  const direct = resolve(packageRoot, clean);
  const src = clean
    .replace(/^dist\//, "src/")
    .replace(/\.d\.[cm]?ts$/, ".ts")
    .replace(/\.[cm]?js$/, ".ts")
    .replace(/\.mjs$/, ".ts")
    .replace(/\.cjs$/, ".ts");
  const candidates = [direct, resolve(packageRoot, src)];
  return candidates
    .flatMap((file) =>
      importCandidates(relative(packageRoot, file)).map((item) => resolve(packageRoot, item)),
    )
    .filter((file) => existsSync(file));
}

function isLikelyForeignFrameworkFile(
  session: ScanSession,
  relativePath: string,
  deps: PackageDependencyFacts,
): boolean {
  for (const root of deps.foreignRoots) {
    if (root && (relativePath === root || relativePath.startsWith(`${root}/`))) return true;
  }
  return (
    relativePath === "next-env.d.ts" ||
    /(^|\/)examples\/(?:browser|vite|solidstart|tanstack-start|react-router|sveltekit|nextjs)\//.test(
      relativePath,
    ) ||
    /(^|\/)next\.config\.[cm]?[jt]s$/.test(relativePath) ||
    /(^|\/)(?:proxy|instrumentation|middleware)\.[jt]s$/.test(relativePath) ||
    /(^|\/)app\/actions\.[jt]sx?$/.test(relativePath) ||
    /(^|\/)app\/(?:layout|page|loading|not-found|error|global-error|template)\.[jt]sx?$/.test(
      relativePath,
    ) ||
    /(^|\/)app\/.+\/route\.[jt]s$/.test(relativePath)
  );
}

function isIgnoredDependencyForUnusedReport(dep: string): boolean {
  return (
    dep.startsWith("@types/") ||
    dep.startsWith("@iconify-json/") ||
    /^(typescript|vue-tsc|vite|vitest|eslint|prettier|tsx|ts-node|jiti)$/.test(dep) ||
    /^(vue|h3)$/.test(dep) ||
    dep.startsWith("@libsql/") ||
    /^@nuxt\/(?:cli|kit|schema|fonts)$/.test(dep)
  );
}

function isTypeSurfaceFile(relativePath: string): boolean {
  return relativePath.endsWith(".d.ts") || /(^|\/)(types|shared\/types)\//.test(relativePath);
}

function findExportFile(graph: WorkspaceGraph, target: ExportFact): string | undefined {
  for (const fact of graph.files.values()) if (fact.exports.includes(target)) return fact.path;
  return undefined;
}

function planNonOverlappingFixes(items: Diagnostic[]) {
  const sorted = items
    .flatMap((item) => item.fix?.edits ?? [])
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

function createCacheKey(session: ScanSession, phase: string, input: string): string {
  return `${phase}:${sha256(
    JSON.stringify({
      version: VERSION,
      phase,
      input,
      config: session.config.rules ?? {},
      preset: session.options.preset,
      manifest: session.project.nuxt?.manifestPath,
      tsconfig: session.project.tsconfigPath,
    }),
  )}`;
}

function safeCacheKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readFileSyncIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function createHelpers(): DoctorHelpers {
  return {
    rangeFromOffsets(file, source, start, end = start) {
      const prefix = source.slice(0, start);
      const lines = prefix.split(/\r?\n/);
      return { start, end, line: lines.length, column: lines.at(-1)!.length + 1 };
    },
    isInSetupLikeContext() {
      return false;
    },
    isClientOnlyExecutionContext(node, source) {
      return isClientOnlyExecutionContext(node, source);
    },
    isTypeOnlyContext(node) {
      return isTypeOnlyContext(node);
    },
    hasLocalBindingBefore(node, source) {
      return hasLocalBindingBefore(node, source);
    },
    isTypeofOperand(node) {
      return isTypeofOperand(node);
    },
    getNodeName(node) {
      return getNodeName(node);
    },
    getCalleeName(node) {
      return getCalleeName(node);
    },
    isCall(node, name) {
      return (node as any)?.type === "CallExpression" && (!name || getCalleeName(node) === name);
    },
    report(ctx, node, diagnostic) {
      ctx.report({
        ...diagnostic,
        file: diagnostic.file ?? ctx.file.path,
        range: diagnostic.range ?? (node ? ctx.range(node) : undefined),
      });
    },
    hasVueDirective(node, name, argument) {
      return ((node as any)?.startTag?.attributes ?? []).some(
        (attr: any) =>
          attr.directive &&
          attr.key?.name?.name === name &&
          (!argument || attr.key?.argument?.name === argument),
      );
    },
    hasVueAttribute(node, name) {
      return ((node as any)?.startTag?.attributes ?? []).some(
        (attr: any) => !attr.directive && attr.key?.name === name,
      );
    },
    getStaticVueAttributeValue(node, name) {
      const attr = ((node as any)?.startTag?.attributes ?? []).find(
        (item: any) => !item.directive && item.key?.name === name,
      );
      return attr?.value?.value ?? null;
    },
    isNuxtServerFile(relativePath) {
      return relativePath.startsWith("server/") || relativePath.startsWith("app/server/");
    },
    isLikelyEventHandler(text, offset) {
      const before = text.slice(Math.max(0, offset - 180), offset);
      return /function\s+on[A-Z]\w+|const\s+on[A-Z]\w+\s*=|@click|v-on:click|addEventListener|onMounted\s*\(/.test(
        before,
      );
    },
  };
}

const CLIENT_LIFECYCLE_CALLEES = new Set([
  "onMounted",
  "onBeforeMount",
  "onUnmounted",
  "onBeforeUnmount",
  "onNuxtReady",
  "onPrehydrate",
]);

const CLIENT_EVENT_CALLEES = new Set([
  "addEventListener",
  "window.addEventListener",
  "document.addEventListener",
  "useEventListener",
  "onKeyDown",
  "onKeyUp",
  "onKeyStroke",
  "onClickOutside",
  "onLongPress",
  "usePointerSwipe",
  "useSwipe",
  "useIntersectionObserver",
  "useResizeObserver",
]);

const DEFERRED_CALLBACK_CALLEES = new Set(["watch", "watchPostEffect"]);
const TIMER_CALLBACK_CALLEES = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
]);

function isClientOnlyExecutionContext(
  node: unknown,
  source: string,
  seenCallChain = new Set<string>(),
): boolean {
  const parents = getDoctorParents(node);
  if (parents.some((parent) => isClientGuardAncestor(parent, node, source))) return true;
  if (parents.some((parent) => isShortCircuitedByClientGuard(parent, node, source))) return true;
  if (
    parents.some((parent) => {
      const callee = getCalleeName(parent);
      return (
        !!callee &&
        (CLIENT_LIFECYCLE_CALLEES.has(callee) ||
          CLIENT_EVENT_CALLEES.has(callee) ||
          callee.endsWith(".addEventListener"))
      );
    })
  )
    return true;

  const functionAncestors = parents.filter((parent) => isFunctionLike(parent));
  if (!functionAncestors.length) return false;

  return functionAncestors.some((functionAncestor) => {
    if (isClientOnlyCallback(functionAncestor, source)) return true;
    if (isDeferredCallback(functionAncestor)) return true;
    if (isComputedSetter(functionAncestor)) return true;
    if (isClientOnlyObjectCallback(functionAncestor)) return true;
    const propertyName = getObjectPropertyKeyName(functionAncestor);
    if (propertyName && /^on[A-Z]/.test(propertyName)) return true;
    const name = getFunctionLikeName(functionAncestor);
    return (
      !!name &&
      (isTemplateEventHandlerReference(source, name) ||
        isReturnedComposableFunction(functionAncestor) ||
        isOnlyCalledFromClientOnlyContext(
          name,
          functionAncestor,
          parents.at(-1),
          source,
          seenCallChain,
        ))
    );
  });
}

function getDoctorParents(node: unknown): any[] {
  const parents = [];
  const seen = new Set<unknown>();
  let current = (node as any)?.__doctorParent;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    parents.push(current);
    current = current.__doctorParent;
  }
  return parents;
}

function isClientGuardAncestor(parent: unknown, node: unknown, source: string): boolean {
  const value = parent as any;
  if (value?.type !== "IfStatement" && value?.type !== "ConditionalExpression") return false;
  if (
    (node as any) !== value.consequent &&
    !isDescendantOf((node as any)?.__doctorParent, value.consequent)
  )
    return false;
  return (
    isClientGuardText(source.slice(value.test?.start ?? 0, value.test?.end ?? 0)) ||
    isClientGuardText(source.slice(value.start ?? 0, value.consequent?.start ?? value.end ?? 0))
  );
}

function isShortCircuitedByClientGuard(parent: unknown, node: unknown, source: string): boolean {
  const value = parent as any;
  if (value?.type !== "LogicalExpression" || value.operator !== "&&") return false;
  if (!isDescendantOf((node as any)?.__doctorParent, value.right)) return false;
  return isClientGuardText(source.slice(value.left?.start ?? 0, value.left?.end ?? 0));
}

function isDescendantOf(node: unknown, ancestor: unknown): boolean {
  let current = node as any;
  while (current && typeof current === "object") {
    if (current === ancestor) return true;
    current = current.__doctorParent;
  }
  return false;
}

function isClientGuardText(text: string): boolean {
  return (
    /\b(import\.meta\.client|process\.client)\b|(?:^|[^\w$])(isBrowser|isClient)(?:\(\)|[^\w$]|$)/.test(
      text,
    ) ||
    /typeof\s+(window|document|localStorage|sessionStorage|navigator)\s*!==?\s*["']undefined["']/.test(
      text,
    )
  );
}

function isFunctionLike(node: unknown): boolean {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    (node as any)?.type,
  );
}

function isClientOnlyCallback(functionNode: unknown, source: string): boolean {
  const parent = (functionNode as any)?.__doctorParent;
  if (!parent || parent.type !== "CallExpression") return false;
  const callee = getCalleeName(parent);
  if (!callee) return false;
  if (CLIENT_LIFECYCLE_CALLEES.has(callee) || CLIENT_EVENT_CALLEES.has(callee)) return true;
  if (callee.endsWith(".addEventListener")) return true;
  if (isNuxtClientHookCallback(functionNode, parent, source)) return true;

  const before = source.slice(Math.max(0, parent.start - 80), parent.start);
  return /@[\w:-]+\s*=|v-on:[\w:-]+\s*=/.test(before);
}

function isNuxtClientHookCallback(functionNode: unknown, call: unknown, source: string): boolean {
  const value = call as any;
  const callee = getCalleeName(value);
  if (!callee?.endsWith(".hook") && !callee?.endsWith(".hookOnce")) return false;
  if (value.arguments?.[1] !== functionNode) return false;
  const first = value.arguments?.[0];
  const hookName =
    first?.type === "Literal" && typeof first.value === "string"
      ? first.value
      : source.slice(first?.start ?? 0, first?.end ?? 0).replace(/^['"]|['"]$/g, "");
  return /^(app:mounted|page:loading:end|page:finish|page:transition:finish)$/.test(hookName);
}

function isComputedSetter(functionNode: unknown): boolean {
  const property = (functionNode as any)?.__doctorParent;
  if (property?.type !== "Property") return false;
  if ((property.key?.name ?? property.key?.value) !== "set") return false;
  const objectExpression = property.__doctorParent;
  const call = objectExpression?.__doctorParent;
  return objectExpression?.type === "ObjectExpression" && getCalleeName(call) === "computed";
}

function isClientOnlyObjectCallback(functionNode: unknown): boolean {
  const property = (functionNode as any)?.__doctorParent;
  const key = property?.key?.name ?? property?.key?.value;
  if (property?.type !== "Property" || key !== "handler") return false;
  return getDoctorParents(property).some((parent) => getCalleeName(parent) === "defineShortcuts");
}

function isDeferredCallback(functionNode: unknown): boolean {
  const parent = (functionNode as any)?.__doctorParent;
  if (!parent || parent.type !== "CallExpression") return false;
  const callee = getCalleeName(parent);
  return !!callee && DEFERRED_CALLBACK_CALLEES.has(callee);
}

function isReturnedComposableFunction(functionNode: unknown): boolean {
  const name = getFunctionLikeName(functionNode);
  if (!name) return false;
  const outer = getDoctorParents(functionNode).find((parent) => isFunctionLike(parent));
  const outerName = getFunctionLikeName(outer);
  if (!outerName?.startsWith("use")) return false;
  if (
    getDoctorParents(functionNode).some((parent) => {
      const value = parent as any;
      return (
        value?.type === "ReturnStatement" ||
        (value?.type === "Property" &&
          ((value.key?.name ?? value.key?.value) === name || value.value === functionNode))
      );
    })
  )
    return true;

  let returned = false;
  walkAst(outer, (node) => {
    const value = node as any;
    if (value?.type !== "ReturnStatement" || value.argument?.type !== "ObjectExpression") return;
    returned ||= value.argument.properties?.some((property: any) => {
      return (
        property?.type === "Property" &&
        ((property.key?.name ?? property.key?.value) === name ||
          (property.value?.type === "Identifier" && property.value.name === name))
      );
    });
  });
  return returned;
}

function isOnlyCalledFromClientOnlyContext(
  name: string,
  declaration: unknown,
  root: unknown,
  source: string,
  seen = new Set<string>(),
): boolean {
  return isOnlyCalledFromClientOnlyContextInner(name, declaration, root, source, seen);
}

function isOnlyCalledFromClientOnlyContextInner(
  name: string,
  declaration: unknown,
  root: unknown,
  source: string,
  seen: Set<string>,
): boolean {
  if (!root || typeof root !== "object") return false;
  if (seen.has(name)) return false;
  seen.add(name);
  const declarationNames = collectDeclarations(root);
  const declarationRange = getFunctionDeclarationRange(declaration);
  const calls: any[] = [];
  walkAst(root, (node) => {
    const value = node as any;
    if (value?.type === "CallExpression" && getCalleeName(node) === name) calls.push(node);
    if (
      value?.type === "Identifier" &&
      value.name === name &&
      !isInsideDeclaration(value, declaration) &&
      !isInsideRange(value, declarationRange) &&
      !declarationNames.has(value.name)
    )
      calls.push(value);
  });
  const externalCalls = calls.filter(
    (call) => !isInsideDeclaration(call, declaration) && !isInsideRange(call, declarationRange),
  );
  if (!externalCalls.length) return false;
  return externalCalls.every((call) => {
    if (isClientOnlyExecutionContext(call, source, seen)) return true;
    const parent = (call as any).__doctorParent;
    const callee = parent?.type === "CallExpression" ? getCalleeName(parent) : null;
    if (
      callee &&
      TIMER_CALLBACK_CALLEES.has(callee) &&
      isClientOnlyExecutionContext(parent, source, seen)
    )
      return true;
    const caller = getDoctorParents(call).find((parent) => isFunctionLike(parent));
    const callerName = getFunctionLikeName(caller);
    return (
      !!callerName && isOnlyCalledFromClientOnlyContextInner(callerName, caller, root, source, seen)
    );
  });
}

function collectDeclarations(root: unknown): Set<string> {
  const names = new Set<string>();
  walkAst(root, (node) => {
    const name = getDeclaredName(node);
    if (name) names.add(name);
  });
  return names;
}

function getDeclaredName(node: unknown): string | null {
  const value = node as any;
  if (value?.type === "FunctionDeclaration") return value.id?.name ?? null;
  if (value?.type === "VariableDeclarator" && value.id?.type === "Identifier") return value.id.name;
  if (value?.type === "Identifier") {
    const parent = value.__doctorParent;
    if (parent?.type === "FunctionDeclaration" && parent.id === value) return value.name;
    if (parent?.type === "VariableDeclarator" && parent.id === value) return value.name;
  }
  return null;
}

function isInsideDeclaration(node: unknown, declaration: unknown): boolean {
  let current = node as any;
  while (current && typeof current === "object") {
    if (current === declaration) return true;
    if (current.__doctorParent === declaration) return true;
    current = current.__doctorParent;
  }
  return false;
}

function getFunctionDeclarationRange(declaration: unknown): { start: number; end: number } | null {
  const node = declaration as any;
  if (typeof node?.start === "number" && typeof node?.end === "number")
    return { start: node.start, end: node.end };
  const parent = node?.__doctorParent;
  if (parent?.type === "VariableDeclarator") {
    const statement = parent.__doctorParent;
    if (typeof statement?.start === "number" && typeof statement?.end === "number")
      return { start: statement.start, end: statement.end };
  }
  return null;
}

function isInsideRange(node: unknown, range: { start: number; end: number } | null): boolean {
  const value = node as any;
  return (
    !!range &&
    typeof value?.start === "number" &&
    value.start >= range.start &&
    value.start <= range.end
  );
}

function walkAst(node: unknown, visit: (node: unknown) => void) {
  const stack = [node];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const typed = current as any;
    if (!typed.type) continue;
    visit(typed);
    const keys = visitorKeys[typed.type] ?? [];
    for (let keyIndex = keys.length - 1; keyIndex >= 0; keyIndex--) {
      const value = typed[keys[keyIndex]];
      if (Array.isArray(value)) {
        for (let childIndex = value.length - 1; childIndex >= 0; childIndex--) {
          stack.push(value[childIndex]);
        }
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
}

function getFunctionLikeName(functionNode: unknown): string | null {
  const node = functionNode as any;
  if (!node || typeof node !== "object") return null;
  if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") return node.id.name;
  const parent = node.__doctorParent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier")
    return parent.id.name;
  if (
    parent?.type === "Property" &&
    (parent.key?.type === "Identifier" || parent.key?.type === "Literal")
  )
    return String(parent.key.name ?? parent.key.value);
  return null;
}

function getObjectPropertyKeyName(functionNode: unknown): string | null {
  const parent = (functionNode as any).__doctorParent;
  if (
    parent?.type === "Property" &&
    (parent.key?.type === "Identifier" || parent.key?.type === "Literal")
  )
    return String(parent.key.name ?? parent.key.value);
  return null;
}

function isTemplateEventHandlerReference(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:@|v-on:)[\\w:-]+\\s*=\\s*["'][^"']*\\b${escaped}\\b`).test(source);
}

function isTypeOnlyContext(node: unknown): boolean {
  return getDoctorParents(node).some((parent) => {
    const type = parent?.type;
    return (
      typeof type === "string" &&
      (type.startsWith("TS") ||
        type === "TypeAnnotation" ||
        type === "TypeAlias" ||
        type === "InterfaceDeclaration")
    );
  });
}

function hasLocalBindingBefore(node: unknown, source: string): boolean {
  const value = node as any;
  if (value?.type !== "Identifier" || typeof value.name !== "string") return false;
  const parent = value.__doctorParent;
  if (parent?.type === "VariableDeclarator" && parent.id === value) return true;
  if (parent?.type === "FunctionDeclaration" && parent.id === value) return true;
  if (parent?.type === "Property" && parent.key === value && !parent.computed) return true;

  const name = value.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = source.slice(0, value.start);
  return new RegExp(
    String.raw`(?:\b(?:const|let|var)\s+${name}\b|[,(]\s*${name}\s*(?::[^)=]+)?=>|\(\s*${name}\s*(?::[^)]*)?\)\s*=>|function[^(]*\([^)]*\b${name}\b|[,(]\s*\{[^)]*\b${name}\b[^)]*\}\s*(?::[^)=]+)?=>|function[^(]*\([^)]*\{[^)]*\b${name}\b)`,
  ).test(before);
}

function isTypeofOperand(node: unknown): boolean {
  const parent = (node as any)?.__doctorParent;
  return parent?.type === "UnaryExpression" && parent.operator === "typeof";
}

function getNodeName(node: unknown): string | null {
  const value = node as any;
  if (!value) return null;
  if (value.type === "Identifier") return value.name;
  if (value.type === "Literal") return String(value.value);
  if (value.type === "StaticMemberExpression" || value.type === "MemberExpression") {
    const object = getNodeName(value.object);
    const property = getNodeName(value.property);
    return object && property ? `${object}.${property}` : (object ?? property);
  }
  return null;
}

function getCalleeName(node: unknown): string | null {
  return getNodeName((node as any)?.callee);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function nativeMatch(value: string, pattern: string): boolean {
  if (matchesGlob(value, pattern)) return true;
  return value === pattern || value.includes(pattern);
}
