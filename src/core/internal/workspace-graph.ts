import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "pathe";
import type {
  Diagnostic,
  ExportFact,
  FileFacts,
  GraphEdge,
  VirtualRootNode,
  WorkspaceGraph,
} from "../primitives.js";
import { resolvedConfigFor, type ScanSession } from "./scan-session.js";
import { nativeMatch, sha256 } from "./utils.js";
import { pushDiagnostic } from "./diagnostics.js";
import { walkAstFacts } from "./facts.js";
import { projectNuxtInventories } from "./workspace-nuxt.js";

interface GraphIndex {
  resolveImport(from: FileFacts, specifier: string): number | undefined;
  packageDeps(): PackageDependencyFacts;
}

const graphIndexes = new WeakMap<WorkspaceGraph, GraphIndex>();

export function buildWorkspaceGraph(session: ScanSession): WorkspaceGraph {
  const index = createGraphIndex(session);
  const files = new Map(session.facts.map((fact) => [fact.fileId, fact]));
  const fileIdsByPath = new Map(session.facts.map((fact) => [fact.path, fact.fileId]));
  const importEdges: GraphEdge[] = [];
  const exportEdges: GraphEdge[] = [];
  const importersByFile = new Map<number, number[]>();
  const exportsByName = new Map<string, ExportFact[]>();
  const refsByExport = new Map<string, Array<{ fileId: number; range?: Diagnostic["range"] }>>();

  for (const fact of session.facts) {
    for (const item of fact.exports) {
      exportEdges.push({
        from: fact.fileId,
        to: item.source ? index.resolveImport(fact, item.source) : undefined,
        specifier: item.source,
        kind: item.source ? (item.kind === "type" ? "type-re-export" : "re-export") : "export",
      });
      const exports = exportsByName.get(item.name) ?? [];
      exports.push(item);
      exportsByName.set(item.name, exports);
    }
    for (const item of fact.imports) {
      const target = index.resolveImport(fact, item.source);
      importEdges.push({
        from: fact.fileId,
        to: target,
        specifier: item.source,
        kind: item.kind === "type" ? "type-import" : "import",
      });
      for (const specifier of item.specifiers) {
        const refs = refsByExport.get(specifier) ?? [];
        refs.push({ fileId: fact.fileId, range: item.range });
        refsByExport.set(specifier, refs);
      }
    }
    for (const item of fact.dynamicImports) {
      if (item.source === null) continue;
      importEdges.push({
        from: fact.fileId,
        to: index.resolveImport(fact, item.source),
        specifier: item.source,
        kind: "dynamic-import",
      });
    }
    for (const item of fact.calls) {
      const refs = refsByExport.get(item.name) ?? [];
      refs.push({ fileId: fact.fileId, range: item.range });
      refsByExport.set(item.name, refs);
    }
  }

  for (const edge of [...importEdges, ...exportEdges]) {
    if (edge.to === undefined) continue;
    const importers = importersByFile.get(edge.to) ?? [];
    importers.push(edge.from);
    importersByFile.set(edge.to, importers);
  }

  const virtualRoots = createVirtualRoots(session, index, fileIdsByPath);
  for (const root of virtualRoots) {
    if (root.fileId === undefined) continue;
    importEdges.push({
      from: root.fileId,
      to: root.fileId,
      kind: "virtual-root",
      specifier: root.id,
    });
  }

  const graph: WorkspaceGraph = {
    files,
    fileIdsByPath,
    importEdges,
    exportEdges,
    virtualRoots,
    reverseIndex: { importersByFile, refsByExport, exportsByName },
    sccs: computeSccs(
      session.facts.map((fact) => fact.fileId),
      [
        ...importEdges.filter((edge) => edge.kind === "import"),
        ...exportEdges.filter((edge) => edge.kind === "re-export"),
      ],
    ),
  };
  graphIndexes.set(graph, index);
  return graph;
}

function createGraphIndex(session: ScanSession): GraphIndex {
  const byRelativePath = new Map(session.facts.map((fact) => [fact.relativePath, fact.fileId]));
  const resolved = new Map<string, number | undefined>();
  const directories = new Map<string, string>();
  let packageDeps: PackageDependencyFacts | undefined;

  const firstMatch = (bases: string[]): number | undefined => {
    for (const base of bases) {
      for (const candidate of importCandidates(base)) {
        const match = byRelativePath.get(candidate);
        if (match !== undefined) return match;
      }
    }
    return undefined;
  };

  const sourceDirectory = (from: FileFacts): string => {
    let directory = directories.get(from.path);
    if (directory === undefined) {
      directory = dirname(from.path);
      directories.set(from.path, directory);
    }
    return directory;
  };

  const resolveUncached = (from: FileFacts, specifier: string): number | undefined => {
    const packageRoot = packageRootForFile(session, from.path);
    if (specifier.startsWith("~~/")) {
      const roots = packageRoot ? [packageRoot] : ["", ...workspacePackageRoots(session)];
      return firstMatch(rootAliasImportBases(roots, specifier.slice(3)));
    }
    if (specifier.startsWith("~/") || specifier.startsWith("@/")) {
      const base = specifier.slice(2);
      const roots = aliasImportRoots(session, packageRoot);
      return firstMatch(roots.map((root) => (root ? `${root}/${base}` : base)));
    }
    return firstMatch([relative(session.root, resolve(sourceDirectory(from), specifier))]);
  };

  return {
    resolveImport(from, specifier) {
      if (!isLocalSpecifier(specifier)) return undefined;
      // Alias imports are scoped to the importing Nuxt package; relative ones are per directory.
      const key = specifier.startsWith(".")
        ? `${sourceDirectory(from)}\0${specifier}`
        : `${packageRootForFile(session, from.path) ?? ""}\0${specifier}`;
      if (resolved.has(key)) return resolved.get(key);
      const target = resolveUncached(from, specifier);
      resolved.set(key, target);
      return target;
    },
    packageDeps() {
      packageDeps ??= readPackageDeps(
        session.root,
        session.files.map((entry) => entry.path),
      );
      return packageDeps;
    },
  };
}

function createVirtualRoots(
  session: ScanSession,
  index: GraphIndex,
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
  for (const file of index.packageDeps().entryFiles) {
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

  for (const nuxt of projectNuxtInventories(session.project)) {
    for (const page of nuxt.manifest?.pages ?? [])
      addRoot("nuxt-page", page.file, "Nuxt manifest page");
    for (const plugin of nuxt.manifest?.pluginFiles ?? [])
      addRoot("nuxt-plugin", plugin, "Nuxt manifest plugin");
    for (const handler of [
      ...nuxt.serverDirs.api,
      ...nuxt.serverDirs.routes,
      ...nuxt.serverDirs.middleware,
      ...nuxt.serverDirs.plugins,
    ])
      addRoot("nuxt-server", handler, "Nuxt server handler");
    for (const component of nuxt.components.values())
      addRoot("nuxt-component", component.file, "Nuxt manifest component");
    for (const source of nuxt.moduleSources ?? [])
      addRoot("nuxt-module", source.root, `Nuxt module source ${source.module}`);
  }
  return roots;
}

function aliasImportRoots(session: ScanSession, packageRoot?: string): string[] {
  if (packageRoot) {
    const inventory = nuxtInventoryForRoot(session, packageRoot);
    const roots = new Set<string>([
      packageRoot === "." ? "" : packageRoot,
      packageRoot === "." ? "app" : `${packageRoot}/app`,
      packageRoot === "." ? "shared" : `${packageRoot}/shared`,
    ]);
    for (const root of inventory?.manifest?.appScanRoots ?? [])
      roots.add(relative(session.root, root));
    return [...roots];
  }
  const roots = new Set(["", "app", "shared"]);
  for (const nuxt of projectNuxtInventories(session.project)) {
    for (const root of nuxt.manifest?.appScanRoots ?? []) roots.add(relative(session.root, root));
  }
  for (const fact of session.facts) {
    const appIndex = fact.relativePath.indexOf("/app/");
    if (appIndex > 0) {
      const prefix = fact.relativePath.slice(0, appIndex);
      roots.add(`${prefix}/app`);
      roots.add(`${prefix}/shared`);
    }
  }
  return [...roots];
}

function packageRootForFile(session: ScanSession, file: string): string | undefined {
  const roots = [
    ...(session.project.workspaceNuxt ?? []).map((item) => item.root),
    ...(session.project.workspacePackages ?? [])
      .filter((item) => item.framework === "nuxt")
      .map((item) => item.root),
  ];
  const relativeFile = relative(session.root, file);
  return roots
    .filter((root) => root === "." || relativeFile === root || relativeFile.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];
}

function nuxtInventoryForRoot(session: ScanSession, root: string) {
  if (root === "." && session.project.nuxt) return session.project.nuxt;
  return (
    session.project.workspaceNuxt?.find((item) => item.root === root)?.nuxt ??
    (session.project.nuxt &&
    session.project.workspacePackages?.some(
      (item) => item.root === root && item.framework === "nuxt",
    )
      ? session.project.nuxt
      : undefined)
  );
}

function rootAliasImportBases(roots: readonly string[], base: string): string[] {
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
  const outputExtension = clean.match(/\.(?:js|jsx|mjs|cjs)$/)?.[0];
  const sourceCandidates = outputExtension
    ? [
        clean.slice(0, -outputExtension.length) + outputExtension.replace("js", "ts"),
        ...(outputExtension === ".js" ? [clean.slice(0, -3) + ".tsx"] : []),
      ]
    : [];
  const exts = [
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
  return [clean, ...sourceCandidates, ...exts.map((ext) => `${clean}${ext}`)];
}

export function runStructuralGraphRules(session: ScanSession, graph: WorkspaceGraph) {
  const analyses = selectedAnalyses(session);
  if (analyses.has("dead-code"))
    runDeadCodeRules(session, graph, graphIndexes.get(graph) ?? createGraphIndex(session));
  if (analyses.has("graph")) runCycleAndDuplicateExportRules(session, graph);
}

function runDeadCodeRules(session: ScanSession, graph: WorkspaceGraph, index: GraphIndex) {
  const live = reachableFiles(graph);
  const packageDeps = index.packageDeps();
  const importedPackages = new Set<string>();

  for (const fact of session.facts) {
    for (const item of [...fact.imports, ...fact.exports, ...fact.dynamicImports]) {
      if (!item.source) continue;
      if (
        !item.source.startsWith(".") &&
        !item.source.startsWith("~/") &&
        !item.source.startsWith("@/") &&
        !item.source.startsWith("~~/") &&
        !isNodeBuiltin(item.source)
      )
        importedPackages.add(packageNameFromSpecifier(item.source));
      if (
        isLocalSpecifier(item.source) &&
        !isGeneratedOrAssetImport(item.source) &&
        !isLikelyForeignFrameworkFile(session, fact.relativePath, packageDeps) &&
        index.resolveImport(fact, item.source) === undefined
      ) {
        reportWorkspaceDiagnostic(session, {
          ruleId: "workspace/dead-code/unresolved-import",
          severity: "error",
          category: "dead-code",
          message: `Import "${item.source}" could not be resolved.`,
          suggestion: "Fix the import specifier or add the missing source file.",
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
      reportWorkspaceDiagnostic(session, {
        ruleId: "workspace/dead-code/unused-file",
        severity: "info",
        category: "dead-code",
        message: "File is not reachable from known package, framework, or manifest roots.",
        suggestion: "Remove the file or import it from a package, framework, or manifest root.",
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
        reportWorkspaceDiagnostic(session, {
          ruleId:
            exp.kind === "type"
              ? "workspace/dead-code/unused-type-export"
              : "workspace/dead-code/unused-export",
          severity: "info",
          category: "dead-code",
          message: `Export "${exp.name}" is not referenced by known imports or framework roots.`,
          suggestion: `Remove export "${exp.name}" or import it from reachable code.`,
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
      reportWorkspaceDiagnostic(session, {
        ruleId: "workspace/dead-code/unused-dependency",
        severity: "info",
        category: "dead-code",
        message: `Dependency "${dep}" is declared but was not imported by scanned source files.`,
        suggestion: `Remove "${dep}" from package.json or import it from scanned source code.`,
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
      !dep.startsWith("#") &&
      !isIgnoredDependencyForUnusedReport(dep)
    ) {
      reportWorkspaceDiagnostic(session, {
        ruleId: "workspace/dead-code/unlisted-dependency",
        severity: "warn",
        category: "dead-code",
        message: `Package "${dep}" is imported but is not listed in package.json dependencies.`,
        suggestion: `Add "${dep}" to package.json dependencies or remove the import.`,
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
    reportWorkspaceDiagnostic(session, {
      ruleId: "workspace/dead-code/circular-dependency",
      severity: "warn",
      category: "architecture",
      message: `Circular dependency detected across ${files.length} files.`,
      suggestion: "Break the cycle by moving shared code into an acyclic module.",
      file: files[0]!,
      related: files.slice(1).map((file) => ({ file, message: "Cycle member" })),
      confidence: "proven",
      evidence: [{ kind: "graph", summary: "Strongly connected component in import graph." }],
      analysisPhase: "graph",
    });
  }
  const exportOwners = new Map<ExportFact, string>();
  for (const fact of graph.files.values()) {
    for (const item of fact.exports) if (!exportOwners.has(item)) exportOwners.set(item, fact.path);
  }
  for (const [name, exports] of graph.reverseIndex.exportsByName) {
    const files = [
      ...new Set(exports.map((item) => exportOwners.get(item)).filter(Boolean)),
    ] as string[];
    if (name === "default" || name === "*" || files.length < 2) continue;
    reportWorkspaceDiagnostic(session, {
      ruleId: "workspace/dead-code/duplicate-export",
      severity: "warn",
      category: "architecture",
      message: `Export name "${name}" appears in multiple files.`,
      suggestion: `Rename or consolidate duplicate export "${name}" so imports resolve unambiguously.`,
      file: files[0]!,
      related: files.slice(1).map((file) => ({ file, message: `Also exports "${name}"` })),
      confidence: "proven",
      evidence: [{ kind: "graph", summary: "Workspace export index contains multiple owners." }],
      analysisPhase: "graph",
    });
  }
}

export function runDuplicationRules(session: ScanSession) {
  if (!selectedAnalyses(session).has("dupes")) return;
  const byHash = new Map<string, string[]>();
  for (const file of session.handles) {
    if (!file.facts) continue;
    for (const hash of new Set(tokenWindowHashes(file.text))) {
      const list = byHash.get(hash) ?? [];
      list.push(file.path);
      byHash.set(hash, list);
    }
  }
  for (const [hash, paths] of byHash) {
    const files = [...new Set(paths)];
    if (files.length < 2) continue;
    reportWorkspaceDiagnostic(session, {
      ruleId: "workspace/duplication/exact-clone",
      severity: "info",
      category: "duplication",
      message: `Repeated token window detected in ${files.length} files.`,
      suggestion: "Extract the repeated code into a shared helper or keep one intentional copy.",
      file: files[0]!,
      related: files.slice(1).map((file) => ({ file, message: `Clone fingerprint ${hash}` })),
      confidence: "heuristic-high",
      evidence: [{ kind: "facts", summary: "Matching normalized token-window hash." }],
      analysisPhase: "duplication",
    });
  }
}

export function runHealthRules(session: ScanSession) {
  if (!selectedAnalyses(session).has("health")) return;
  for (const file of session.handles) {
    const fact = file.facts;
    if (!fact) continue;
    const cyclomatic = cyclomaticComplexity(file.scriptAst);
    if (cyclomatic >= 15) {
      reportWorkspaceDiagnostic(session, {
        ruleId: "workspace/health/high-cyclomatic-complexity",
        severity: "warn",
        category: "health",
        message: `File has cyclomatic complexity ${cyclomatic}.`,
        suggestion: "Split complex branches into smaller rules, helpers, or modules.",
        file: fact.path,
        confidence: "heuristic-high",
        evidence: [{ kind: "facts", summary: "Complexity counted from branch syntax." }],
        analysisPhase: "health",
      });
    }
    if (fact.imports.length >= 20) {
      reportWorkspaceDiagnostic(session, {
        ruleId: "workspace/health/high-fan-out",
        severity: "info",
        category: "health",
        message: `File imports ${fact.imports.length} modules.`,
        suggestion: "Reduce fan-out by moving cohesive dependencies behind smaller modules.",
        file: fact.path,
        confidence: "heuristic-high",
        evidence: [{ kind: "graph", summary: "Import fan-out from file facts." }],
        analysisPhase: "health",
      });
    }
  }
}

const BRANCH_NODE_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "ConditionalExpression",
  "LogicalExpression",
  "SwitchCase",
]);

function cyclomaticComplexity(ast: Record<string, unknown> | null | undefined): number {
  let cyclomatic = 1;
  if (ast)
    walkAstFacts(ast, (node) => {
      if (BRANCH_NODE_TYPES.has((node as { type: string }).type)) cyclomatic++;
    });
  return cyclomatic;
}

function tokenWindowHashes(text: string): string[] {
  const tokens = (
    text.match(/[A-Za-z_$][\w$]*|\d+|=>|===|!==|==|!=|[{}()[\].,;:+\-*/%<>]/g) ?? []
  ).map((token) => (/^[A-Za-z_$]/.test(token) ? token : token.replace(/\d+/g, "0")));
  const hashes: string[] = [];
  const window = 30;
  for (let index = 0; index + window <= tokens.length; index += 10) {
    hashes.push(sha256(tokens.slice(index, index + window).join(" ")).slice(0, 16));
  }
  return hashes;
}

function selectedAnalyses(session: ScanSession): Set<string> {
  const requested = session.options.analyses
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(requested ?? []);
}

function reachableFiles(graph: WorkspaceGraph): Set<number> {
  const live = new Set<number>();
  const targetsByFile = new Map<number, number[]>();
  for (const edge of [...graph.importEdges, ...graph.exportEdges]) {
    if (edge.to === undefined) continue;
    const targets = targetsByFile.get(edge.from) ?? [];
    targets.push(edge.to);
    targetsByFile.set(edge.from, targets);
  }
  const queue = graph.virtualRoots.flatMap((root) =>
    root.fileId === undefined ? [] : [root.fileId],
  );
  for (const fact of graph.files.values()) {
    if (fact.exports.some((item) => graph.reverseIndex.refsByExport.has(item.name)))
      queue.push(fact.fileId);
  }
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (live.has(id)) continue;
    live.add(id);
    for (const target of targetsByFile.get(id) ?? []) if (!live.has(target)) queue.push(target);
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

function readPackageDeps(root: string, inventoryPaths: readonly string[]): PackageDependencyFacts {
  const all = new Set<string>();
  const runtime = new Set<string>();
  const foreignRoots = new Set<string>();
  const entryFiles = new Set<string>();
  const entries = createPackageEntryResolver(inventoryPaths);
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
      for (const entry of packageEntryCandidates(root, packageRoot, json, entries))
        entryFiles.add(entry);
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
  return name.startsWith("node:") || isBuiltin(name);
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

interface PackageEntryResolver {
  inventoryPaths: readonly string[];
  inventoriedFiles(): Set<string>;
  sourceCandidates(packageRoot: string, entry: string): string[];
}

// Monorepo export maps expand into thousands of candidate paths, most under an unbuilt dist/ or
// below a file (`src/index.ts/index.ts`). Checking each parent directory once lets those misses
// skip the filesystem.
function createPackageEntryResolver(inventoryPaths: readonly string[]): PackageEntryResolver {
  let inventoriedFiles: Set<string> | undefined;
  const directories = new Map<string, boolean>();
  const byEntry = new Map<string, string[]>();
  const byTarget = new Map<string, string[]>();
  const mayContainFiles = (directory: string): boolean => {
    let result = directories.get(directory);
    if (result === undefined) {
      const parent = dirname(directory);
      result = parent === directory || mayContainFiles(parent);
      if (result) {
        try {
          result = statSync(directory, { throwIfNoEntry: false })?.isDirectory() ?? false;
        } catch {
          result = true;
        }
      }
      directories.set(directory, result);
    }
    return result;
  };
  const fileExists = (file: string) => mayContainFiles(dirname(file)) && existsSync(file);
  const existingCandidates = (packageRoot: string, file: string) => {
    const key = `${packageRoot}\0${file}`;
    let files = byTarget.get(key);
    if (!files) {
      const path = relative(packageRoot, file);
      const prefix = `${packageRoot}/`;
      // A normalized path below the package only gains extensions or `/index.*`, so joining
      // matches `resolve` without paying for it on every candidate.
      const joinable = path !== "" && file === prefix + path;
      files = importCandidates(path)
        .map((item) => (joinable ? prefix + item : resolve(packageRoot, item)))
        .filter(fileExists);
      byTarget.set(key, files);
    }
    return files;
  };
  return {
    inventoryPaths,
    inventoriedFiles() {
      inventoriedFiles ??= new Set(inventoryPaths.map((file) => resolve(file)));
      return inventoriedFiles;
    },
    sourceCandidates(packageRoot, entry) {
      if (!entry || entry.startsWith("#")) return [];
      const key = `${packageRoot}\0${entry}`;
      let files = byEntry.get(key);
      if (!files) {
        const clean = entry.replace(/^\.\//, "");
        const src = clean
          .replace(/^dist\//, "src/")
          .replace(/\.d\.[cm]?ts$/, ".ts")
          .replace(/\.[cm]?js$/, ".ts")
          .replace(/\.mjs$/, ".ts")
          .replace(/\.cjs$/, ".ts");
        files = [
          ...existingCandidates(packageRoot, resolve(packageRoot, clean)),
          ...existingCandidates(packageRoot, resolve(packageRoot, src)),
        ];
        byEntry.set(key, files);
      }
      return files;
    },
  };
}

function packageEntryCandidates(
  root: string,
  packageRoot: string,
  json: Record<string, unknown>,
  entries: PackageEntryResolver,
): string[] {
  const candidates = new Set<string>();
  const binEntries =
    typeof json.bin === "string"
      ? [json.bin]
      : json.bin && typeof json.bin === "object" && !Array.isArray(json.bin)
        ? Object.values(json.bin)
        : [];
  for (const value of [json.main, json.module, json.types, json.typings, ...binEntries]) {
    if (typeof value !== "string") continue;
    for (const file of entries.sourceCandidates(packageRoot, value)) candidates.add(file);
  }
  const directories = json.directories as Record<string, unknown> | undefined;
  if (!json.bin && typeof directories?.bin === "string" && directories.bin) {
    const binRoot = resolve(packageRoot, directories.bin);
    if (isPathInside(packageRoot, binRoot)) {
      const inventoriedFiles = entries.inventoriedFiles();
      for (const file of entries.inventoryPaths) {
        if (!isPathInside(binRoot, file)) continue;
        const path = relative(packageRoot, file);
        for (const candidate of entries.sourceCandidates(packageRoot, path)) {
          if (inventoriedFiles.has(candidate)) candidates.add(candidate);
        }
      }
    }
  }
  collectPackageExportEntries(packageRoot, json.exports, candidates, entries);
  for (const standard of ["src/index.ts", "src/module.ts", "src/preview.ts"]) {
    const absolute = resolve(packageRoot, standard);
    if (existsSync(absolute)) candidates.add(absolute);
  }
  return [...candidates].filter((file) => isPathInside(root, file));
}

function isPathInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return (
    path === "" ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith("../") &&
      !path.startsWith("..\\") &&
      !path.startsWith("/") &&
      !path.startsWith("\\"))
  );
}

function collectPackageExportEntries(
  packageRoot: string,
  value: unknown,
  candidates: Set<string>,
  entries: PackageEntryResolver,
): void {
  if (typeof value === "string") {
    for (const file of entries.sourceCandidates(packageRoot, value)) candidates.add(file);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectPackageExportEntries(packageRoot, item, candidates, entries);
  }
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
  return /\.d\.[cm]?ts$/.test(relativePath) || /(^|\/)(types|shared\/types)\//.test(relativePath);
}

function reportWorkspaceDiagnostic(
  session: ScanSession,
  diagnostic: Parameters<typeof pushDiagnostic>[1],
): void {
  const wanted = session.options.rules
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (wanted?.length && !wanted.some((pattern) => nativeMatch(diagnostic.ruleId, pattern))) return;
  const config = resolvedConfigFor(session, diagnostic.ruleId);
  if (config.enabled === false) return;
  pushDiagnostic(session, { ...diagnostic, severity: config.severity ?? diagnostic.severity });
}
