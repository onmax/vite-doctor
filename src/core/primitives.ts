import type { Diagnostic as NosticsDiagnostic } from "nostics";
import { doctorInternalDiagnostics } from "./internal-diagnostic-handles.js";
export { DOCTOR_DIAGNOSTICS_DOCS_BASE } from "./diagnostic-constants.js";

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

export interface AutoImportEntry {
  name: string;
  as?: string;
  from: string;
  kind: "nuxt" | "vue" | "module" | "app" | "layer";
  sourceLayer?: string;
  type?: boolean;
}

export interface NuxtProjectInfo {
  version: string;
  appDir: string;
  appRoots: string[];
  autoImportEnabled: boolean;
  autoImportsAuthoritative: boolean;
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
  doctorConfig?: DoctorSerializableConfig;
  manifestPath?: string;
  modules?: Array<{ name: string; version?: string; doctorPlugin?: string }>;
  moduleSources?: NuxtModuleSource[];
  manifest?: {
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
  tsconfigPath?: string;
  languages?: ProjectLanguage[];
  nuxt?: NuxtProjectInfo;
  runtimeGraph?: RuntimeGraph;
  nuxtCompatibility?: NuxtCompatibilityInfo;
  inventory?: Record<string, unknown>;
  runtimeEvidence?: Record<string, unknown>;
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

export interface RuleContext {
  project: ProjectInfo;
  file: SourceFileHandle;
  sfc?: SfcHandle;
  severity: DoctorSeverity;
  options: unknown;
  report(diagnostic: NosticsDiagnostic, metadata: DoctorDiagnosticMetadata): void;
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
  SFC?(sfc: SfcHandle): void | Promise<void>;
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
  presets: { recommended: string[]; strict?: string[] } & Record<string, string[] | undefined>;
  activation?: {
    languages?: ProjectLanguage[];
    packages?: string[];
    modules?: string[];
    nuxt?: string;
  };
}

export interface DoctorRunResult {
  version: string;
  reportVersion?: 3;
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

export interface DoctorExtension {
  name: string;
  version?: string;
  rulePacks?: RulePack[];
  reporters?: Reporter[];
  setup?(api: DoctorExtensionApi): void | Promise<void>;
}

export interface DoctorExtensionApi {
  registerRulePack(pack: RulePack): void;
  registerReporter(reporter: Reporter): void;
  registerProjectDetector(detector: ProjectDetector): void;
  registerProjectInventoryContributor(contributor: ProjectInventoryContributor): void;
  registerRuntimeEvidenceContributor(contributor: RuntimeEvidenceContributor): void;
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
  return pack;
}

export function defineDoctorExtension(extension: DoctorExtension): DoctorExtension {
  for (const pack of extension.rulePacks ?? []) defineRulePack(pack);
  return extension;
}
