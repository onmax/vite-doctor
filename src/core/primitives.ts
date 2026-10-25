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
  /**
   * Where a file Rule's Diagnostics can land. `"file"` (the default) means only the file being
   * analyzed, `file` and `related` locations included, and Doctor enforces it. `"project"` lets
   * the Rule report on any file. Manifest and workspace Rules are always project-scoped.
   */
  reportScope?: "file" | "project";
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
  /** The inline HTML `<template>` as a compiler-dom AST, or `null` for `src` or non-HTML templates. */
  getTemplateAst(): TemplateRootNode | null;
  getScriptAst(kind?: "script" | "scriptSetup" | "merged"): Record<string, unknown> | null;
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
    compilerScan?: boolean;
    priority: number;
  }>;
  localLayerAliases?: boolean;
  routeRules?: Record<string, unknown>;
  /** `false` when the Nuxt app disables server-side rendering. */
  ssr?: boolean;
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
    keyedComposables: NuxtKeyedComposable[];
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

/**
 * A function Nuxt injects keys into. `source` is the absolute module file Nuxt resolved the
 * registration to; registrations without one match by name alone.
 */
export interface NuxtKeyedComposable {
  name: string;
  source?: string;
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
    compilerScan?: boolean;
    name?: string;
    priority: number;
  }>;
  localLayerAliases?: boolean;
  aliases: Record<string, string>;
  routeRules: Record<string, unknown>;
  ssr?: boolean;
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

/** The Rule Packs whose Activation matched, and the Rule Packs whose Presets Config Extends selected. */
export interface RulePackSelection {
  activated: string[];
  selected: string[];
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
  /** A node_modules symlink for this package whose target no longer exists. */
  danglingLink?: { path: string; target: string };
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
  /** Component facts of a Vue SFC with a script or template. */
  component?: ComponentFacts;
}

/** A component a Vue SFC template renders, and what the template passes to it. */
export interface ComponentUsageFact {
  /** The tag as written, such as `UserCard` or `user-card`. */
  tag: string;
  /** The tag name in the start tag. */
  range: SourceRange;
  /** Static attributes, named as written. */
  attributes: Array<{ name: string; value?: string; range: SourceRange }>;
  /**
   * `:name` bindings with a static argument, named as written. `v-model` lands here as
   * `modelValue` and `v-model:name` as `name`, both with `model: true`.
   */
  bindings: Array<{
    name: string;
    expression: string;
    model?: boolean;
    modifiers?: boolean;
    range: SourceRange;
  }>;
  /** Object spreads, `v-bind="attrs"` and `v-on="handlers"`, and dynamic arguments such as `:[name]`. */
  spreads: Array<{ directive: "bind" | "on"; expression: string; range: SourceRange }>;
  /** `@event` listeners with a static argument, named as written. */
  listeners: Array<{ event: string; expression?: string; range: SourceRange }>;
  /** Other directives on the element, such as `if`, `show`, `slot`, `for`, or a custom directive. */
  directives: string[];
  /** Names that an enclosing `v-for` or `v-slot` introduces, or a `v-for` on this element. */
  scope: string[];
  /** Whether this element or an ancestor has `v-for`. */
  inFor: boolean;
}

export interface ComponentPropFact {
  name: string;
  /** Whether the declaration gives the prop a default value. */
  default: boolean;
  range?: SourceRange;
}

/** What a Vue SFC declares in `<script setup>` and renders in its template. */
export interface ComponentFacts {
  /** Props `<script setup>` declares, or `undefined` when they cannot be read statically. */
  props?: ComponentPropFact[];
  /** The name `const props = defineProps()` binds. */
  propsBinding?: string;
  /** Destructured props, local name to prop name. */
  propAliases?: Record<string, string>;
  /** Events `<script setup>` declares, or `undefined` when they cannot be read statically. */
  emits?: string[];
  /** The name `const emit = defineEmits()` binds. */
  emitBinding?: string;
  /** `defineModel()` declarations, with the prop name each one adds. */
  models: Array<{ name: string; binding?: string; default: boolean; range?: SourceRange }>;
  /** Value imports in `<script setup>`, which its template can render as tags. */
  imports: Array<{ local: string; imported: string; source: string }>;
  /**
   * Whether the component runs code of its own: `<script setup>` statements other than imports,
   * type declarations, and macro declarations, macro defaults included, or any `<script>` code.
   */
  ownLogic: boolean;
  /**
   * Whether the template renders or controls something besides component usages, `<slot>`
   * outlets, and slot templates: an element, text, an interpolation, or a built-in component.
   */
  ownMarkup: boolean;
  /** Template root nodes, comments excluded. */
  rootNodes: number;
  /** Equality comparisons between two member paths as written, such as `id === props.activeId`. */
  comparisons: Array<{ left: string; right: string; in: "script" | "template" }>;
  /** Components the template renders, in source order. */
  usages: ComponentUsageFact[];
  /** Imported names the component references outside a template tag, in script code or template expressions. */
  bindingReferences: string[];
}

/** A component usage in an SFC template, resolved to the SFC it renders when Doctor can prove it. */
export interface ComponentUsageEdge {
  /** The SFC whose template contains the usage. */
  from: string;
  usage: ComponentUsageFact;
  /** The rendered SFC. */
  target?: string;
  /** How Doctor resolved `target`. */
  resolvedBy?: "import" | "nuxt-components";
}

export interface ComponentNode {
  file: string;
  relativePath: string;
  sourceKind: SourceFileHandle["sourceKind"];
  facts: ComponentFacts;
  /** Usages in this component's template. */
  renders: ComponentUsageEdge[];
  /** Resolved usages of this component in other templates. */
  callers: ComponentUsageEdge[];
  /**
   * Files that import this SFC other than as a `<script setup>` tag binding: script modules,
   * re-exports, dynamic imports, Options API `<script>` imports, or SFCs that also reference the
   * binding in code. Usages through them are invisible to `callers`.
   */
  indirectImporters: string[];
}

/** Project Inventory of which Vue SFCs render which components, built from File Facts. */
export interface ComponentUsageGraph {
  /** Every Vue SFC in the Doctor Run with component facts, keyed by absolute path. */
  components: ReadonlyMap<string, ComponentNode>;
  /**
   * Usages Doctor cannot resolve to an SFC in the run: globally registered or auto-imported
   * components without a known registry entry, package components, and namespaced tags.
   */
  unresolved: ComponentUsageEdge[];
}

/** Project Inventory derived from the Doctor Run's source files. */
export interface RuleInventory {
  /** Available to `workspace` and `manifest` Rules, which see the whole project. */
  componentUsage(): Promise<ComponentUsageGraph>;
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
  /**
   * Whether the identifier names a binding declared in an enclosing scope (parameter, variable,
   * function, class, import, destructured name, catch parameter) instead of a global.
   */
  hasLocalBinding(node: unknown): boolean;
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
  /** Whether the element has `v-<name>`, or `v-<name>:<argument>` with a static argument. */
  hasVueDirective(element: TemplateElementNode, name: string, argument?: string): boolean;
  /** Whether the element has a static attribute such as `alt` or `alt="..."`. */
  hasVueAttribute(element: TemplateElementNode, name: string): boolean;
  getStaticVueAttributeValue(element: TemplateElementNode, name: string): string | null;
  /**
   * Parses a template expression with oxc on first use. Node offsets are SFC offsets and the
   * result is shared by every Rule. Returns `null` for static or invalid expressions and for
   * values that are not one expression: a whole `v-for` (parse `forParseResult.source` instead),
   * `v-slot` parameters, or a `v-on` handler with several statements.
   */
  parseTemplateExpression(expression: TemplateExpressionNode): ScriptAstNode | null;
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
  templateAst?: TemplateRootNode | null;
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
  /** Project Inventory derived from the run's source files. Results that read it are not cached. */
  inventory: RuleInventory;
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

/** A compiler-dom source position. `offset` is an SFC offset; `line` and `column` start at 1. */
export interface TemplatePosition {
  offset: number;
  line: number;
  column: number;
}

/** A compiler-dom source location. `source` is the raw SFC text it covers. */
export interface TemplateSourceLocation {
  start: TemplatePosition;
  end: TemplatePosition;
  source: string;
}

/**
 * A compiler-dom expression: a directive value, a directive argument or modifier, or the
 * content of an interpolation. `content` is the decoded text; parse it with
 * `ctx.helpers.parseTemplateExpression`.
 */
export interface TemplateExpressionNode {
  type: 4;
  content: string;
  /** `true` for static directive arguments and modifiers, such as `href` in `:href`. */
  isStatic: boolean;
  loc: TemplateSourceLocation;
}

export interface TemplateRootNode {
  type: 0;
  source: string;
  children: TemplateChildNode[];
  loc: TemplateSourceLocation;
}

export interface TemplateElementNode {
  type: 1;
  /** The tag as written, such as `button`, `NuxtLink`, or `router-view`. */
  tag: string;
  /** 0 element, 1 component, 2 `<slot>`, 3 `<template>` with a directive. */
  tagType: 0 | 1 | 2 | 3;
  ns: number;
  props: Array<TemplateAttributeNode | TemplateDirectiveNode>;
  children: TemplateChildNode[];
  isSelfClosing?: boolean;
  loc: TemplateSourceLocation;
}

export interface TemplateTextNode {
  type: 2;
  content: string;
  loc: TemplateSourceLocation;
}

export interface TemplateCommentNode {
  type: 3;
  content: string;
  loc: TemplateSourceLocation;
}

export interface TemplateInterpolationNode {
  type: 5;
  content: TemplateExpressionNode;
  loc: TemplateSourceLocation;
}

/** A static attribute such as `alt="Logo"`. */
export interface TemplateAttributeNode {
  type: 6;
  name: string;
  nameLoc: TemplateSourceLocation;
  value: TemplateTextNode | undefined;
  loc: TemplateSourceLocation;
}

/** A directive. Shorthands are normalized: `:href`, `@click`, and `#default` are `bind`, `on`, and `slot`. */
export interface TemplateDirectiveNode {
  type: 7;
  name: string;
  /** The attribute name as written, such as `:href.camel` or `v-on:click`. */
  rawName?: string;
  exp: TemplateExpressionNode | undefined;
  arg: TemplateExpressionNode | undefined;
  modifiers: TemplateExpressionNode[];
  forParseResult?: {
    source: TemplateExpressionNode;
    value: TemplateExpressionNode | undefined;
    key: TemplateExpressionNode | undefined;
    index: TemplateExpressionNode | undefined;
  };
  loc: TemplateSourceLocation;
}

export type TemplateChildNode =
  | TemplateElementNode
  | TemplateTextNode
  | TemplateCommentNode
  | TemplateInterpolationNode;
export type TemplateParentNode = TemplateRootNode | TemplateElementNode;
export type TemplateAstNode =
  | TemplateRootNode
  | TemplateChildNode
  | TemplateAttributeNode
  | TemplateDirectiveNode;

/** Template visitor keys and the node each one receives. */
export interface TemplateNodeKinds {
  root: TemplateRootNode;
  element: TemplateElementNode;
  attribute: TemplateAttributeNode;
  directive: TemplateDirectiveNode;
  text: TemplateTextNode;
  interpolation: TemplateInterpolationNode;
  comment: TemplateCommentNode;
}
export type TemplateNodeKind = keyof TemplateNodeKinds;

/** The second visitor argument: the owning element for props, the parent for children. */
export interface TemplateNodeParents {
  root: undefined;
  element: TemplateParentNode;
  attribute: TemplateElementNode;
  directive: TemplateElementNode;
  text: TemplateParentNode;
  interpolation: TemplateParentNode;
  comment: TemplateParentNode;
}

/**
 * Template node visitors keyed by compiler-dom node kind. An element's attributes and
 * directives are visited in source order before its children. `"<kind>:exit"` runs after the
 * node's props and children.
 */
export type TemplateVisitor = {
  [K in TemplateNodeKind]?: (node: TemplateNodeKinds[K], parent: TemplateNodeParents[K]) => void;
} & {
  [K in TemplateNodeKind as `${K}:exit`]?: (
    node: TemplateNodeKinds[K],
    parent: TemplateNodeParents[K],
  ) => void;
};

/**
 * File rules share read-only ASTs. For each file, all create() calls finish in enabled-rule
 * order, then all SFC hooks finish in that order. Script nodes (DFS, enter then exit), then
 * template nodes (DFS, enter then exit), dispatch to visitors in rule order per node. Script
 * parents are fully linked before script dispatch. Traversal is snapshotted; AST mutation is
 * unsupported. Cross-rule state must not depend on another rule completing its traversal first.
 */
export interface RuleLifecycleHooks {
  onWorkspaceStart?(): void | Promise<void>;
  onProjectStart?(project: ProjectInfo): void | Promise<void>;
  SFC?(sfc: SfcHandle): void | Promise<void>;
  NuxtManifest?(manifest: NuxtProjectInfo): void;
  onProjectEnd?(project: ProjectInfo): void | Promise<void>;
  onWorkspaceEnd?(): void | Promise<void>;
}

export type RuleVisitor = RuleLifecycleHooks &
  ScriptVisitor & {
    /** Visitors for the Vue SFC `<template>`, keyed by compiler-dom node kind. */
    template?: TemplateVisitor;
  };

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
    /**
     * `changed` reports changed lines from Git (`changed`, `since`); `affected` reports the
     * `affectedFiles` the caller passed. Both analyze the whole project.
     */
    mode: "all" | "changed" | "affected";
    base?: string | null;
    /** Files analyzed, or in a scoped mode, files whose Diagnostics the run reports. */
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
  rulePacks?: RulePackSelection;
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
