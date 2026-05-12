import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "pathe";
import type {
  Diagnostic,
  ExportFact,
  FileFacts,
  GraphEdge,
  VirtualRootNode,
  WorkspaceGraph,
} from "../primitives.js";
import type { ScanSession } from "./scan-session.js";
import { pushDiagnostic } from "./diagnostics.js";

export function buildWorkspaceGraph(session: ScanSession): WorkspaceGraph {
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

export function runStructuralGraphRules(session: ScanSession, graph: WorkspaceGraph) {
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

export function runDuplicationRules(session: ScanSession) {
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

export function runHealthRules(session: ScanSession) {
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

function selectedAnalyses(session: ScanSession): Set<string> {
  const requested = session.options.analyses
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(requested ?? []);
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
