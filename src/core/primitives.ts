import type { Diagnostic as NosticsDiagnostic } from "nostics";
import type { Node as OxcNode } from "oxc-parser";
import { assertExtensionDiagnosticCode, type DoctorDiagnosticRegistry } from "./diagnostics.js";
import { doctorInternalDiagnostics } from "./internal-diagnostic-handles.js";
export {
  DOCTOR_DIAGNOSTICS_DOCS_BASE,
  RESERVED_DIAGNOSTIC_CODE_PREFIXES,
} from "./diagnostic-constants.js";

export type DoctorSeverity = "blocker" | "error" | "warn" | "info";
export type DoctorReportFormat = "text" | "json" | "sarif" | "agent";
export type DoctorRuleConfig = "off" | DoctorSeverity | [DoctorSeverity, unknown];
export interface DoctorSerializableConfig {
  extends?: "auto" | string[];
  include?: string[];
  exclude?: string[];
  rules?: Record<string, DoctorRuleConfig>;
  suppressions?: Array<{ ruleId?: string; fingerprint?: string; file?: string; reason: string }>;
  cache?: { dir?: string; strategy?: "content-hash" };
  score?: { weights?: Partial<Record<"blocker" | "error" | "warn" | "info", number>> };
}
export type FixSafety = "safe" | "unsafe" | "suggestion" | "structural-review";
export type DoctorFramework = "vue" | "nuxt" | "vite" | "nitro";
export type ProjectLanguage = "typescript" | "javascript";
export type RuntimePackageName = "nuxt" | "nitro" | "h3" | "vue";
export type ApplicabilityState = "active" | "inactive" | "unknown";
export type ExecutionKind = "file" | "manifest" | "workspace" | "graph" | "duplication" | "health";
export type RuleCost = "tiny" | "small" | "medium" | "large" | "xlarge";
export type CacheScope = "none" | "file-text" | "sfc-block" | "workspace-graph" | "run";
export type Determinism = "deterministic" | "env-dependent" | "runtime-dependent";
export type EvidenceKind =
  | "facts"
  | "ast"
  | "graph"
  | "types"
  | "manifest"
  | "coverage"
  | "git"
  | "runtime";
export type Confidence =
  | "proven"
  | "type-backed"
  | "manifest-backed"
  | "runtime-backed"
  | "heuristic-high"
  | "heuristic-medium"
  | "heuristic-low";

export interface SourceRange {
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface FixEdit {
  range: { start: number; end: number };
  text: string;
}

export interface Fix {
  kind: FixSafety;
  message?: string;
  edits: FixEdit[];
}

export interface Diagnostic {
  diagnostic: NosticsDiagnostic;
  code: string;
  why: string;
  docs?: string;
  sources?: string[];
  ruleId: string;
  severity: DoctorSeverity;
  category: string;
  message: string;
  file: string;
  range?: SourceRange;
  suggestion?: string;
  fix?: Fix | null;
  related?: Array<{ file: string; range?: SourceRange; message: string }>;
  tags?: string[];
  fingerprint?: string;
  suppressed?: boolean;
  suppressionReason?: string;
  confidence?: Confidence;
  evidence?: DiagnosticEvidence[];
  fixGroupId?: string;
  analysisPhase?: ExecutionKind;
  cacheHit?: boolean;
}

export interface DiagnosticEvidence {
  kind: EvidenceKind;
  summary: string;
  file?: string;
  range?: SourceRange;
  relatedId?: string;
}

export interface RuleMeta {
  id: string;
  title: string;
  description?: string;
  why?: string;
  recommendedReplacement?: string;
  examples?: RuleExample[];
  category: string;
  severity: DoctorSeverity;
  fixable?: FixSafety | false;
  docsUrl?: string;
  diagnosticCodes?: string[];
  version?: string;
  requiresContext?: Array<"manifest" | "cross-file" | "template" | "script">;
  frameworkVersions?: {
    vue?: string;
    nuxt?: string;
  };
  applicability?: {
    runtimes?: Partial<Record<RuntimePackageName, string>>;
    nuxtCompatibility?: string;
    includePrerelease?: boolean;
  };
  aiGeneratedCodeRisk?: "low" | "medium" | "high";
  requires?: {
    sfc?: boolean;
    template?: boolean;
    script?: boolean;
    vue?: boolean;
    nitro?: boolean;
    nuxt?: boolean;
    crossFile?: boolean;
  };
  supports?: {
    vue?: string;
    nuxt?: string;
    node?: string;
  };
  /**
   * Skips a file Rule, including `create()`, on files that cannot match. The Rule runs when the
   * file has any listed signal, so list every entry point the Rule reports from.
   */
  prefilter?: RulePrefilter;
  sourceKinds?: Array<"app" | "layer" | "module">;
  execution?: ExecutionKind;
  cost?: RuleCost;
  cacheScope?: CacheScope;
  determinism?: Determinism;
  parallelSafe?: boolean;
  producesEvidence?: EvidenceKind[];
  consumesEvidence?: EvidenceKind[];
}

export interface RulePrefilter {
  /** Callee names as in `FileFacts.calls`, such as `useFetch` or `Math.random`. */
  calls?: readonly string[];
  /** Import sources as in `FileFacts.imports`, such as `h3`. */
  imports?: readonly string[];
  /** Names the file text could spell, escape sequences included, for aliases and non-call uses. */
  names?: readonly string[];
}

export interface SfcBlockHashes {
  template?: string;
  script?: string;
  scriptSetup?: string;
  styles: string[];
  custom: string[];
}

export interface SfcHandle {
  file: string;
  source: string;
  hash: string;
  descriptor: unknown;
  blockHashes: SfcBlockHashes;
  getTemplateAst(): Record<string, unknown> | null;
  getScriptAst(kind?: "script" | "scriptSetup" | "merged"): Record<string, unknown> | null;
  getTemplateTokens(): unknown;
  offsetToPosition(offset: number): SourceRange;
  blockOffsetToFileOffset(block: "template" | "script" | "scriptSetup", offset: number): number;
}

export interface AutoImportEntry {
  name: string;
  as?: string;
  from: string;
  kind: "nuxt" | "vue" | "module" | "app" | "layer";
  sourceLayer?: string;
  type?: boolean;
  priority?: number;
}

export interface NuxtProjectInfo {
  version: string;
  appDir: string;
  appRoots: string[];
  autoImportEnabled: boolean;
  autoImportsAuthoritative: boolean;
  autoImports: Map<string, AutoImportEntry>;
  /** All resolved auto-import entries, including names shadowed in the lookup map. */
  autoImportEntries?: AutoImportEntry[];
  components: Map<
    string,
    { name: string; file: string; mode?: "client" | "server" | "all"; sourceLayer?: string }
  >;
  layers: Array<{
    name?: string;
    root: string;
    srcDir?: string;
    appMiddlewareDir?: string;
    serverDir?: string;
    aliases?: Record<string, string>;
    priority: number;
  }>;
  localLayerAliases?: boolean;
  routeRules?: Record<string, unknown>;
  runtimeConfig?: unknown;
  serverDirs: {
    api: string[];
    routes: string[];
    middleware: string[];
    plugins: string[];
  };
  doctorConfig?: DoctorSerializableConfig;
  manifestPath?: string;
  modules?: Array<{ name: string; version?: string; doctorPlugin?: string }>;
  moduleSources?: NuxtModuleSource[];
  manifest?: {
    scannedComposableFiles?: string[];
    importsDirs: string[];
    pluginFiles: string[];
    keyedComposables: string[];
    aliases: Record<string, string>;
    autoImportTransform?: {
      include: Array<{ source: string; flags: string }>;
      exclude: Array<{ source: string; flags: string }>;
    };
    appScanRoots: string[];
    sharedScanRoots: string[];
    hasManifest: boolean;
    isCurrent: boolean;
    serverHandlers?: NuxtDoctorManifest["serverHandlers"];
    resolvedServerHandlers?: NuxtDoctorManifest["serverHandlers"];
    pages?: Array<{ path?: string; file?: string; name?: string }>;
    prerenderRoutes?: string[];
    buildManifest?: {
      hasBuildManifest: boolean;
      chunks: Array<{ file?: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean }>;
    };
    evidence?: {
      routeGraph: boolean;
      buildManifest: boolean;
      prerenderRoutes: number;
      serverRoutes: number;
    };
  };
}

export interface NuxtModuleSource {
  module: string;
  root: string;
  packageDir?: string;
  include?: string[];
  exclude?: string[];
  runtimeDirs?: string[];
  appDirs?: string[];
}

export interface NuxtModuleDefinition {
  /** `package` is a publishable module package; `local` is auto-registered from an app `modules/` directory. */
  kind: "package" | "local";
  entry: string;
  /** Directory that owns module definition code, or the entry itself for single-file local modules. */
  root: string;
  runtimeDir?: string;
  /** The package root is also a Nuxt layer, so Nuxt transforms its files even inside node_modules. */
  layer?: boolean;
}

export interface NuxtDoctorManifest {
  scannedComposableFiles?: string[];
  autoRegisteredLayers?: string[];
  generatedAt?: string;
  nuxtConfigMtimeMs?: number;
  nuxtVersion: string;
  vueVersion: string;
  compatibilityVersion?: number;
  rootDir: string;
  srcDir: string;
  appDir: string;
  buildDir: string;
  autoImportEnabled?: boolean;
  autoImportTransform?: {
    include: Array<{ source: string; flags: string }>;
    exclude: Array<{ source: string; flags: string }>;
  };
  autoImports: unknown[];
  components: unknown[];
  layers: Array<{
    root: string;
    nuxtConfigMtimeMs?: number | null;
    srcDir?: string;
    appMiddlewareDir?: string;
    serverDir?: string;
    aliases?: Record<string, string>;
    name?: string;
    priority: number;
  }>;
  localLayerAliases?: boolean;
  aliases: Record<string, string>;
  routeRules: Record<string, unknown>;
  serverHandlers: Array<{ route?: string; file: string; method?: string; middleware?: boolean }>;
  resolvedServerHandlers?: NuxtDoctorManifest["serverHandlers"];
  serverInventory?: Record<string, string[]>;
  serverHandlerMtimes?: Record<string, number>;
  pages?: Array<{ path?: string; file?: string; name?: string }>;
  prerenderRoutes?: string[];
  buildManifest?: {
    hasBuildManifest: boolean;
    chunks: Array<{ file?: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean }>;
  };
  modules: Array<{ name: string; version?: string; doctorPlugin?: string }>;
  moduleSources?: NuxtModuleSource[];
  /** Absolute Doctor Extension entry modules registered through `doctor:extendExtensions`. */
  extensions?: string[];
  doctorConfig?: DoctorSerializableConfig;
  runtimeConfig?: unknown;
  keyedComposables?: unknown[];
  importsDirs?: string[];
  pluginFiles?: string[];
  appScanRoots?: string[];
  sharedScanRoots?: string[];
}

export interface ProjectInfo {
  root: string;
  framework: DoctorFramework;
  ssr: boolean;
  vueVersion: string;
  nuxtVersion?: string;
  isMonorepo: boolean;
  packageName?: string;
  workspacePackages?: WorkspacePackage[];
  /**
   * Nuxt Project Inventory of Nuxt workspace packages that do not own `nuxt`. Rules read it
   * through `ctx.project` for files those packages own.
   */
  workspaceNuxt?: WorkspaceNuxtInventory[];
  tsconfigPath?: string;
  languages?: ProjectLanguage[];
  nuxt?: NuxtProjectInfo;
  nuxtModuleDefinitions?: NuxtModuleDefinition[];
  runtimeGraph?: RuntimeGraph;
  nuxtCompatibility?: NuxtCompatibilityInfo;
  evidenceGaps?: Array<{ source: string; message: string; files: string[] }>;
  inventory?: Record<string, unknown>;
  runtimeEvidence?: Record<string, unknown>;
}

export interface WorkspacePackage {
  /** Path relative to the Doctor Run root; `.` is the workspace root. */
  root: string;
  name?: string;
  framework: DoctorFramework;
  packages: Record<string, string>;
}

export interface WorkspaceNuxtInventory extends Pick<
  ProjectInfo,
  "nuxtVersion" | "nuxtModuleDefinitions" | "runtimeGraph" | "nuxtCompatibility"
> {
  /** Workspace package root relative to the Doctor Run root. */
  root: string;
  nuxt: NuxtProjectInfo;
}

/** The Rule Packs whose Activation matched one workspace package. */
export interface WorkspacePackageActivation {
  root: string;
  name?: string;
  framework: DoctorFramework;
  rulePacks: string[];
}

export interface RuntimePackageInstance {
  runtime: RuntimePackageName;
  state: "resolved" | "unknown";
  requestedName: string;
  name?: string;
  version?: string;
  packageJsonPath?: string;
  resolvedPath?: string;
  owner: "project" | RuntimePackageName;
  provenance: "node-resolve" | "target";
  declaration?: string;
  identity?: "exact" | "alias" | "unknown";
  reason?: string;
}

export interface RuntimeGraphEdge {
  from: "project" | RuntimePackageName;
  to: RuntimePackageName;
  state: "resolved" | "unknown";
}

export interface RuntimeGraph {
  packages: Partial<Record<RuntimePackageName, RuntimePackageInstance>>;
  edges: RuntimeGraphEdge[];
}

export interface NuxtCompatibilityInfo {
  state: "resolved" | "unknown";
  version?: number;
  provenance: "manifest" | "config" | "default" | "target";
  reason?: string;
  file?: string;
}

export interface RuntimeTarget {
  nuxt?: string;
  nitro?: string;
  h3?: string;
  vue?: string;
  nuxtCompatibility?: number;
}

export interface ImportFact {
  source: string;
  specifiers: string[];
  kind: "value" | "type" | "mixed";
  range?: SourceRange;
}

export interface ExportFact {
  name: string;
  kind: "value" | "type" | "mixed";
  localName?: string;
  source?: string;
  range?: SourceRange;
}

export interface DynamicImportFact {
  source: string | null;
  range?: SourceRange;
}

export interface CallFact {
  name: string;
  range?: SourceRange;
}

export interface MacroFact {
  name: string;
  range?: SourceRange;
}

export interface TemplateFact {
  name: string;
  value?: string;
  range?: SourceRange;
}

export interface FileFacts {
  fileId: number;
  path: string;
  relativePath: string;
  sourceKind: SourceFileHandle["sourceKind"];
  moduleName?: string;
  lang: "ts" | "tsx" | "js" | "jsx" | "vue" | "md" | "mdc" | "unknown";
  fileHash: string;
  sfc?: SfcBlockHashes;
  imports: ImportFact[];
  exports: ExportFact[];
  dynamicImports: DynamicImportFact[];
  calls: CallFact[];
  templateRefs: TemplateFact[];
  macros: MacroFact[];
  diagnosticsHints: string[];
}

export interface GraphEdge {
  from: number;
  to?: number;
  specifier?: string;
  kind:
    | "import"
    | "type-import"
    | "dynamic-import"
    | "export"
    | "re-export"
    | "type-re-export"
    | "virtual-root";
}

export interface VirtualRootNode {
  id: string;
  file?: string;
  fileId?: number;
  kind:
    | "package"
    | "nuxt-page"
    | "nuxt-plugin"
    | "nuxt-server"
    | "nuxt-component"
    | "nuxt-auto-import"
    | "nuxt-layer"
    | "nuxt-module"
    | "config";
  evidence: string;
}

export interface WorkspaceGraph {
  files: Map<number, FileFacts>;
  fileIdsByPath: Map<string, number>;
  importEdges: GraphEdge[];
  exportEdges: GraphEdge[];
  virtualRoots: VirtualRootNode[];
  reverseIndex: {
    importersByFile: Map<number, number[]>;
    refsByExport: Map<string, Array<{ fileId: number; range?: SourceRange }>>;
    exportsByName: Map<string, ExportFact[]>;
  };
  sccs: number[][];
}

export interface RuleCache {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

export interface RuleFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly size: number;
}

export interface RuleDirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Read-only file access for Rules. Relative paths resolve from the project root, and missing or
 * unreadable paths return `undefined` instead of throwing.
 */
export interface RuleFileSystem {
  readText(path: string): string | undefined;
  /** Parsed JSON, or `undefined` when the file is missing or is not valid JSON. Validate it before use. */
  readJson(path: string): unknown;
  exists(path: string): boolean;
  /** Follows symbolic links, like `fs.statSync`. */
  stat(path: string): RuleFileStat | undefined;
  readDir(path: string): RuleDirEntry[] | undefined;
  /** Paths relative to `path`, breadth-first, like `fs.readdirSync(path, { recursive: true })`. */
  readDirRecursive(path: string): string[] | undefined;
  realpath(path: string): string | undefined;
  /** Absolute paths matching a glob pattern, like `fs.globSync`. `cwd` defaults to the project root. */
  glob(pattern: string, options?: { cwd?: string; exclude?: readonly string[] }): string[];
}

export interface DoctorHelpers {
  rangeFromOffsets(file: string, source: string, start: number, end?: number): SourceRange;
  isInSetupLikeContext(node: unknown): boolean;
  isClientOnlyExecutionContext(node: unknown, source: string): boolean;
  isTypeOnlyContext(node: unknown): boolean;
  hasLocalBindingBefore(node: unknown, source: string): boolean;
  isTypeofOperand(node: unknown): boolean;
  getNodeName(node: unknown): string | null;
  getCalleeName(node: unknown): string | null;
  isCall(node: unknown, name?: string): boolean;
  report(
    ctx: RuleContext,
    node: unknown,
    diagnostic: NosticsDiagnostic,
    metadata: DoctorDiagnosticMetadata & {
      file?: string;
      range?: SourceRange;
    },
  ): void;
  hasVueDirective(node: unknown, name: string, argument?: string): boolean;
  hasVueAttribute(node: unknown, name: string): boolean;
  getStaticVueAttributeValue(node: unknown, name: string): string | null;
  isNuxtServerFile(relativePath: string): boolean;
  isLikelyEventHandler(text: string, offset: number): boolean;
}

export type DoctorDiagnosticInput = Omit<
  Diagnostic,
  "diagnostic" | "code" | "why" | "docs" | "sources" | "file" | "range" | "fingerprint"
> & {
  diagnostic?: NosticsDiagnostic;
  code?: string;
  why?: string;
  docs?: string;
  sources?: string[];
  file?: string;
  range?: SourceRange;
  fingerprint?: string;
};

export type DoctorDiagnosticMetadata = Omit<
  Diagnostic,
  "diagnostic" | "code" | "why" | "docs" | "sources" | "message" | "file" | "range"
> & {
  file?: string;
  range?: SourceRange;
};

export interface SourceFileHandle {
  path: string;
  relativePath: string;
  sourceKind: "app" | "layer" | "module";
  moduleName?: string;
  text: string;
  hash: string;
  isVueSfc: boolean;
  scriptAst?: Record<string, unknown> | null;
  templateAst?: Record<string, unknown> | null;
  sfc?: SfcHandle;
  project: ProjectInfo;
  facts?: FileFacts;
  matches(pattern: string): boolean;
  inAppDir(dir: string): boolean;
  isModuleSource(): boolean;
}

/** `ruleId`, `severity`, and `category` default to the reporting Rule's meta. */
export type RuleReportMetadata = Omit<
  DoctorDiagnosticMetadata,
  "ruleId" | "severity" | "category"
> &
  Partial<Pick<DoctorDiagnosticMetadata, "ruleId" | "severity" | "category">>;

export interface RuleContext {
  project: ProjectInfo;
  file: SourceFileHandle;
  sfc?: SfcHandle;
  severity: DoctorSeverity;
  options: unknown;
  report(diagnostic: NosticsDiagnostic, metadata?: RuleReportMetadata): void;
  /** The only file system a Rule may read. Doctor records every read as a Rule input. */
  fs: RuleFileSystem;
  /** Run-scoped memory shared by all Rules. Entries carry the Rule inputs read to compute them. */
  cache: RuleCache;
  helpers: DoctorHelpers;
  range(nodeOrStart: unknown, end?: number): SourceRange | undefined;
}

export interface RuleExample {
  title?: string;
  language?: string;
  invalid?: string;
  valid?: string;
}

/** An ESTree script node as produced by oxc-parser, the parser behind every script AST. */
export type ScriptAstNode = OxcNode;
export type ScriptAstNodeType = ScriptAstNode["type"];
/** The script node for one ESTree type, such as `ScriptAstNodeOf<"CallExpression">`. */
export type ScriptAstNodeOf<T extends ScriptAstNodeType> = Extract<ScriptAstNode, { type: T }>;

/**
 * Script node visitors keyed by ESTree node type, the shape ESLint and oxlint use.
 * `"<Type>:exit"` runs after the node's children.
 */
export type ScriptVisitor = {
  [T in ScriptAstNodeType]?: (node: ScriptAstNodeOf<T>) => void;
} & {
  [T in ScriptAstNodeType as `${T}:exit`]?: (node: ScriptAstNodeOf<T>) => void;
};

/**
 * File rules share read-only ASTs. For each file, all create() calls finish in enabled-rule
 * order, then all SFC hooks finish in that order. Script nodes (DFS, enter then exit), then
 * template nodes, dispatch to visitors in rule order per node. Script parents are fully
 * linked before script dispatch. Script traversal is snapshotted; AST mutation is unsupported.
 * Cross-rule state must not depend on another rule completing its traversal first.
 */
export interface RuleLifecycleHooks {
  onWorkspaceStart?(): void | Promise<void>;
  onProjectStart?(project: ProjectInfo): void | Promise<void>;
  SFC?(sfc: SfcHandle): void | Promise<void>;
  TemplateNode?(node: unknown): void;
  NuxtManifest?(manifest: NuxtProjectInfo): void;
  onProjectEnd?(project: ProjectInfo): void | Promise<void>;
  onWorkspaceEnd?(): void | Promise<void>;
}

export type RuleVisitor = RuleLifecycleHooks & ScriptVisitor;

export interface DoctorRule {
  meta: RuleMeta;
  create(ctx: RuleContext): RuleVisitor | void | Promise<RuleVisitor | void>;
}

export interface RulePack {
  name: string;
  version: string;
  rules: DoctorRule[];
  /** Diagnostic Codes owned by this Rule Pack, created with `defineDoctorDiagnostics`. */
  diagnostics?: Pick<DoctorDiagnosticRegistry, "codesByRuleIdAll" | "docsByCode">;
  presets: { recommended: string[]; strict?: string[] } & Record<string, string[] | undefined>;
  activation?:
    | false
    | {
        frameworks?: DoctorFramework[];
        languages?: ProjectLanguage[];
        packages?: string[];
        modules?: string[];
        nuxt?: string;
      };
}

export interface DoctorRunResult {
  version: string;
  reportVersion?: 3;
  extends?: DoctorSerializableConfig["extends"];
  framework: DoctorFramework;
  root: string;
  scope: {
    mode: "all" | "changed";
    base?: string | null;
    files: number;
    deletedFiles?: number;
  };
  score: number;
  categoryScores: Record<string, number>;
  summary: {
    blocker: number;
    error: number;
    warn: number;
    info: number;
    fixable: number;
  };
  diagnostics: Diagnostic[];
  suppressedDiagnostics?: Diagnostic[];
  fixes?: {
    files: number;
    edits: number;
    skipped: number;
  };
  timings?: Record<string, number>;
  phases?: Record<string, number>;
  ruleTimings?: Array<{ rule: string; ms: number; files: number }>;
  workspacePackages?: WorkspacePackageActivation[];
  graph?: {
    files: number;
    importEdges: number;
    exportEdges: number;
    virtualRoots: number;
    cycles: number;
  };
  project: ProjectInfo;
}

export interface DoctorExtension {
  /** Stable identity. A Doctor Run registers each name once; the first registration wins. */
  name: string;
  version?: string;
  rulePacks?: RulePack[];
  setup?(api: DoctorExtensionApi): void | Promise<void>;
}

/** Loads a Doctor Extension only when a Doctor Run needs it. */
export type DoctorExtensionLoader = () =>
  | DoctorExtension
  | { default: DoctorExtension }
  | Promise<DoctorExtension | { default: DoctorExtension }>;

export type DoctorExtensionInput = DoctorExtension | DoctorExtensionLoader;

/**
 * Contract a host plugin exposes as `api.doctor` so Plugin Surfaces in the same host attach
 * its Doctor Extensions automatically.
 */
export interface DoctorPluginApi {
  extensions: DoctorExtensionInput[];
}

export interface DoctorExtensionApi {
  registerRulePack(pack: RulePack): void;
  registerProjectInventoryContributor(contributor: ProjectInventoryContributor): void;
  registerRuntimeEvidenceContributor(contributor: RuntimeEvidenceContributor): void;
}

export interface ProjectInventoryContributor {
  name: string;
  contribute(project: ProjectInfo): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface RuntimeEvidenceContributor {
  name: string;
  contribute(project: ProjectInfo): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export function createRule(rule: DoctorRule): DoctorRule {
  return rule;
}

export function defineRulePack(pack: RulePack): RulePack {
  if (!pack.presets?.recommended?.length) {
    throw doctorInternalDiagnostics.DOC0015({ pack: pack.name });
  }
  for (const code of Object.keys(pack.diagnostics?.docsByCode ?? {})) {
    assertExtensionDiagnosticCode(code, `Rule Pack "${pack.name}"`);
  }
  return pack;
}

export function defineDoctorPluginApi(api: DoctorPluginApi): DoctorPluginApi {
  return api;
}

export function defineDoctorExtension(extension: DoctorExtension): DoctorExtension {
  const names = new Set<string>();
  for (const pack of extension.rulePacks ?? []) {
    defineRulePack(pack);
    if (names.has(pack.name)) throw doctorInternalDiagnostics.DOC0023({ pack: pack.name });
    names.add(pack.name);
  }
  return extension;
}
