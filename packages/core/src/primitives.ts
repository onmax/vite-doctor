export type DoctorSeverity = "blocker" | "error" | "warn" | "info";
export type FixSafety = "safe" | "unsafe" | "suggestion" | "structural-review";
export type DoctorFramework = "vue" | "nuxt";
export type ExecutionKind =
  | "file"
  | "manifest"
  | "workspace"
  | "graph"
  | "type"
  | "duplication"
  | "health";
export type RuleCost = "tiny" | "small" | "medium" | "large" | "xlarge";
export type CacheScope =
  | "none"
  | "file-text"
  | "sfc-block"
  | "workspace-graph"
  | "type-project"
  | "run";
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
  version?: string;
  requiresContext?: Array<"manifest" | "types" | "cross-file" | "template" | "script">;
  frameworkVersions?: {
    vue?: string;
    nuxt?: string;
  };
  aiGeneratedCodeRisk?: "low" | "medium" | "high";
  requires?: {
    sfc?: boolean;
    template?: boolean;
    script?: boolean;
    types?: boolean;
    vue?: boolean;
    nuxt?: boolean;
    crossFile?: boolean;
  };
  supports?: {
    vue?: string;
    nuxt?: string;
    node?: string;
  };
  sourceKinds?: Array<"app" | "layer" | "module">;
  execution?: ExecutionKind;
  cost?: RuleCost;
  cacheScope?: CacheScope;
  determinism?: Determinism;
  parallelSafe?: boolean;
  producesEvidence?: EvidenceKind[];
  consumesEvidence?: EvidenceKind[];
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

export interface TypeGraph {
  programId: string;
  projectRoots?: string[];
  files?: string[];
  resolveType(file: string, offset: number): unknown;
  findSymbolRefs(file: string, offset: number): Array<{ file: string; range: SourceRange }>;
  resolveExportTarget?(file: string, exportName: string): ResolvedSymbol | null;
}

export interface ResolvedSymbol {
  file: string;
  name: string;
  range?: SourceRange;
}

export interface AutoImportEntry {
  name: string;
  as?: string;
  from: string;
  kind: "nuxt" | "vue" | "module" | "app" | "layer";
  sourceLayer?: string;
}

export interface NuxtProjectInfo {
  version: string;
  appDir: string;
  appRoots: string[];
  autoImports: Map<string, AutoImportEntry>;
  components: Map<
    string,
    { name: string; file: string; mode?: "client" | "server" | "all"; sourceLayer?: string }
  >;
  layers: Array<{ name?: string; root: string; priority: number }>;
  routeRules?: Record<string, unknown>;
  runtimeConfig?: unknown;
  serverDirs: {
    api: string[];
    routes: string[];
    middleware: string[];
    plugins: string[];
  };
  manifestPath?: string;
  modules?: Array<{ name: string; version?: string; doctorPlugin?: string }>;
  moduleSources?: NuxtModuleSource[];
  manifest?: {
    importsDirs: string[];
    pluginFiles: string[];
    keyedComposables: string[];
    aliases: Record<string, string>;
    appScanRoots: string[];
    sharedScanRoots: string[];
    hasManifest: boolean;
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

export interface NuxtDoctorManifest {
  nuxtVersion: string;
  vueVersion: string;
  rootDir: string;
  srcDir: string;
  appDir: string;
  buildDir: string;
  autoImports: unknown[];
  components: unknown[];
  layers: Array<{ root: string; name?: string; priority: number }>;
  aliases: Record<string, string>;
  routeRules: Record<string, unknown>;
  serverHandlers: Array<{ route?: string; file: string; method?: string; middleware?: boolean }>;
  pages?: Array<{ path?: string; file?: string; name?: string }>;
  prerenderRoutes?: string[];
  buildManifest?: {
    hasBuildManifest: boolean;
    chunks: Array<{ file?: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean }>;
  };
  modules: Array<{ name: string; version?: string; doctorPlugin?: string }>;
  moduleSources?: NuxtModuleSource[];
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
  tsconfigPath?: string;
  nuxt?: NuxtProjectInfo;
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

export interface ComplexityFact {
  cyclomatic: number;
  cognitive: number;
  lines: number;
}

export interface TokenFingerprintFacts {
  hashes: string[];
  normalizedTokens: string[];
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
  complexity: ComplexityFact;
  tokens: TokenFingerprintFacts;
  diagnosticsHints: string[];
}

export interface GraphEdge {
  from: number;
  to?: number;
  specifier?: string;
  kind: "import" | "type-import" | "dynamic-import" | "export" | "re-export" | "virtual-root";
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
    diagnostic: Omit<Diagnostic, "file" | "range" | "fingerprint"> & {
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

export interface RuleContext {
  project: ProjectInfo;
  file: SourceFileHandle;
  sfc?: SfcHandle;
  types?: TypeGraph;
  severity: DoctorSeverity;
  options: unknown;
  report(diagnostic: Diagnostic): void;
  getFileText(file: string): string;
  getJson<T = unknown>(file: string): T | null;
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

export interface RuleVisitor {
  onWorkspaceStart?(): void | Promise<void>;
  onProjectStart?(project: ProjectInfo): void | Promise<void>;
  SFC?(sfc: SfcHandle): void;
  TemplateNode?(node: unknown): void;
  ScriptNode?(node: unknown): void;
  ImportDeclaration?(node: unknown): void;
  NuxtManifest?(manifest: NuxtProjectInfo): void;
  onProjectEnd?(project: ProjectInfo): void | Promise<void>;
  onWorkspaceEnd?(): void | Promise<void>;
}

export interface DoctorRule {
  meta: RuleMeta;
  create(ctx: RuleContext): RuleVisitor | void | Promise<RuleVisitor | void>;
}

export interface RulePack {
  name: string;
  version: string;
  rules: DoctorRule[];
  presets?: Record<string, string[]>;
  activation?: {
    packages?: string[];
    modules?: string[];
    nuxt?: string;
  };
}

export interface DoctorRunResult {
  version: string;
  reportVersion?: 2;
  framework: DoctorFramework;
  root: string;
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
  timings?: Record<string, number>;
  phases?: Record<string, number>;
  graph?: {
    files: number;
    importEdges: number;
    exportEdges: number;
    virtualRoots: number;
    cycles: number;
  };
  project: ProjectInfo;
}

export interface Reporter {
  name: string;
  write(result: DoctorRunResult): Promise<void> | void;
}

export interface DoctorPlugin {
  name: string;
  version?: string;
  rulePacks?: RulePack[];
  reporters?: Reporter[];
  setup?(api: DoctorPluginApi): void | Promise<void>;
}

export interface DoctorPluginApi {
  registerRulePack(pack: RulePack): void;
  registerReporter(reporter: Reporter): void;
  registerProjectDetector(detector: ProjectDetector): void;
  registerNuxtManifestContributor?(contributor: NuxtManifestContributor): void;
}

export interface ProjectDetector {
  name: string;
  detect(root: string): Promise<ProjectInfo | null>;
}

export interface NuxtManifestContributor {
  name: string;
  contribute(project: ProjectInfo): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export function createRule(rule: DoctorRule): DoctorRule {
  return rule;
}

export function defineDoctorPlugin(plugin: DoctorPlugin): DoctorPlugin {
  return plugin;
}
