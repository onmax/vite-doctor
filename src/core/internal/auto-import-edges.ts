import { isAbsolute } from "node:path";
import { join, relative, resolve } from "pathe";
import picomatch from "picomatch";
import type {
  AutoImportEntry,
  FileFacts,
  ImportGraphEdge,
  NuxtProjectInfo,
  SourceFileHandle,
  SourceRange,
} from "../primitives.js";
import type { ScanSession } from "./scan-session.js";
import type { GraphIndex } from "./workspace-graph.js";
import { loadSourceFile, walkAstFacts } from "./facts.js";
import { verifyNitroAutoImportScan } from "./nitro-auto-import-scan.js";
import {
  analyzeScript,
  scopeDialect,
  type ScopeDialect,
  type ScopeReference,
  type ScriptScope,
} from "./script-scope.js";
import { createVueScriptForParsing } from "./sfc.js";

/** A file reading a binding that Nuxt or Nitro auto-imports from another source file of the run. */
export interface AutoImportEdge {
  from: number;
  to: number;
  autoImportBundle: NonNullable<ImportGraphEdge["autoImportBundle"]>;
  /** The auto-imported identifier, such as `useCart`. */
  name: string;
  /** The file's first unshadowed reference to `name`. */
  range: SourceRange;
}

const edgesBySession = new WeakMap<ScanSession, Promise<readonly AutoImportEdge[]>>();
const completedEdges = new WeakMap<ScanSession, readonly AutoImportEdge[]>();
const clientParticipation = new WeakMap<
  ScanSession,
  (from: number, to: number) => boolean | undefined
>();

export function sessionClientParticipation(session: ScanSession) {
  return clientParticipation.get(session);
}

/** Auto-import edges collected for this run, or none when nothing asked for them. */
export function sessionAutoImportEdges(session: ScanSession): readonly AutoImportEdge[] {
  return completedEdges.get(session) ?? [];
}

/**
 * Collects edges for unshadowed runtime reads of auto-imports whose source is a file of the run.
 * Files reachable from both entry graphs resolve independently against both registries.
 * Auto-imports from packages (`ref`, `useFetch`) never become edges.
 * Template references are left out: rendered components are Component Usage, and template
 * expressions are not scope-analyzed. Only a current Nuxt manifest proves which names are
 * auto-imported, so a registry that is missing, or that lists an export its file no longer has,
 * gives no auto-import edges and an evidence gap instead. Concurrent callers share one collection.
 */
export function collectAutoImportEdges(
  session: ScanSession,
  index: GraphIndex,
): Promise<readonly AutoImportEdge[]> {
  let pending = edgesBySession.get(session);
  if (!pending) {
    pending = collect(session, index).then((edges) => {
      completedEdges.set(session, edges);
      return edges;
    });
    edgesBySession.set(session, pending);
  }
  return pending;
}

async function collect(
  session: ScanSession,
  index: GraphIndex,
): Promise<readonly AutoImportEdge[]> {
  const edges: AutoImportEdge[] = [];
  const registries = new Map<string, Registry>();
  const gaps = new Map<string, EvidenceGap>();
  const factsById = new Map(session.facts.map((fact) => [fact.fileId, fact]));
  const ids = new Map<NuxtProjectInfo, number>();
  const serverFiles = new Set<number>();
  const nitroQueue: FileFacts[] = [];
  const appFiles = new Set<number>();
  const appQueue: FileFacts[] = [];
  const clientEntries = new Set<number>();
  const serverEntries = new Set<number>();
  const appDependencies = new Map<number, number[]>();
  const scanTargets = new Map<NuxtProjectInfo, Set<number | undefined>>();
  const projectOf = (fact: FileFacts) => session.handlesByPath.get(fact.path)?.project.nuxt;
  const enqueue = (file: number | undefined, nuxt: NuxtProjectInfo, server: boolean) => {
    const fact = file === undefined ? undefined : factsById.get(file);
    const visited = server ? serverFiles : appFiles;
    if (fact && !visited.has(fact.fileId) && projectOf(fact) === nuxt) {
      visited.add(fact.fileId);
      (server ? nitroQueue : appQueue).push(fact);
    }
  };
  for (const fact of session.facts) {
    const nuxt = projectOf(fact);
    if (!nuxt) continue;
    if (!ids.has(nuxt)) {
      ids.set(nuxt, ids.size);
      if (nuxt.manifest?.isCurrent) {
        for (const file of [
          ...(nuxt.manifest.resolvedServerHandlers ?? []).map((handler) => handler.file),
          ...(nuxt.nitroAutoImports?.plugins ?? []),
        ])
          enqueue(index.resolveFile(file), nuxt, true);
        const registrations = [
          ...(nuxt.manifest.pages ?? []),
          ...(nuxt.manifest.resolvedComponents ?? []),
          ...(nuxt.manifest.resolvedPlugins ?? []),
          ...(nuxt.manifest.resolvedMiddleware ?? []).map((file) => ({ file, mode: "all" })),
        ];
        for (const file of nuxt.manifest.pluginFiles) enqueue(index.resolveFile(file), nuxt, false);
        for (const { file, mode } of registrations) {
          if (!file) continue;
          const target = index.resolveFile(file);
          enqueue(target, nuxt, false);
          if (target !== undefined && appFiles.has(target))
            (mode === "server" ? serverEntries : clientEntries).add(target);
        }
        scanTargets.set(
          nuxt,
          new Set(
            nuxt.nitroAutoImports?.entries
              ?.filter(({ from }) => isAbsolute(from))
              .map(({ from }) => index.resolveFile(from)),
          ),
        );
      }
    }
    if (isServerFile(fact, nuxt)) enqueue(fact.fileId, nuxt, true);
    else if (isAppEntry(fact, nuxt)) {
      enqueue(fact.fileId, nuxt, false);
      clientEntries.add(fact.fileId);
    }
  }

  function follow(fact: FileFacts, to: number | undefined, nuxt: NuxtProjectInfo, server: boolean) {
    enqueue(to, nuxt, server);
    if (server || to === undefined || !appFiles.has(to) || projectOf(factsById.get(to)!) !== nuxt)
      return;
    const dependencies = appDependencies.get(fact.fileId);
    if (dependencies) dependencies.push(to);
    else appDependencies.set(fact.fileId, [to]);
  }

  async function collectFile(fact: FileFacts, server: boolean, followDependencies: boolean) {
    const handle = session.handlesByPath.get(fact.path);
    const nuxt = handle?.project.nuxt;
    if (!handle || !nuxt) return;
    const nitro = nuxt.nitroAutoImports;
    if (server ? nitro?.enabled === false : !nuxt.autoImportEnabled) return;
    const key = `${ids.get(nuxt)}:${server ? "nitro" : "nuxt"}`;
    if (gaps.has(key)) return;
    const entries = server ? nitro?.entries : nuxt.runtimeAutoImportEntries;
    if (
      server
        ? !nitro?.authoritative || !nitro.scan || !nitro.transform || nitro.customResolver !== false
        : !nuxt.autoImportsAuthoritative || !entries
    ) {
      gaps.set(
        key,
        server ? unprovenNitroAutoImportsGap(session, nuxt) : unprovenAutoImportsGap(session, nuxt),
      );
      return;
    }
    if (!entries) return;
    const text = handle.text;
    if (
      server
        ? !isTransformedNitroFile(fact.path, text, nitro?.transform)
        : !isTransformedAppFile(fact, nuxt)
    )
      return;
    let registry = registries.get(key);
    if (!registry) {
      const scan = server ? nitro?.scan : undefined;
      if (scan) {
        const verification = await verifyNitroAutoImportScan(
          scan,
          nitro?.installedPackageJsonPath,
          session.options.hostExtensions === true,
        );
        if (verification !== "current") {
          gaps.set(key, unprovenNitroAutoImportsGap(session, nuxt, verification));
          return;
        }
      }
      const aliases = server ? [] : appAliases(nuxt);
      registry = projectOwnedAutoImports(
        entries,
        aliases,
        (path) => index.resolveFile(path),
        factsById,
      );
      registries.set(key, registry);
      if (registry.stale)
        gaps.set(
          key,
          staleAutoImportsGap(session, nuxt, registry.stale, server ? "Nitro" : "Nuxt"),
        );
    }
    if (registry.stale) return;
    const owned = registry.owned;
    // A Unicode escape can spell a registered name without its literal text.
    if (!text.includes("\\u") && ![...owned.keys()].some((name) => text.includes(name))) return;
    const script = await scriptSource(fact, handle);
    const scope = script && analyzeScript(script.text, script.dialect);
    if (!scope) return;
    const seen = new Set<string>();
    for (const reference of runtimeReads(scope, script.setup)) {
      const name = reference.identifier.name;
      const to = owned.get(name);
      if (to === undefined || to === fact.fileId || seen.has(name)) continue;
      seen.add(name);
      if (followDependencies) follow(fact, to, nuxt, server);
      const [start, end] = reference.identifier.range;
      edges.push({
        from: fact.fileId,
        to,
        autoImportBundle: server ? "nitro" : "nuxt",
        name,
        range: session.helpers.rangeFromOffsets(fact.path, text, start, end),
      });
    }
  }

  for (const [queue, server] of [
    [nitroQueue, true],
    [appQueue, false],
  ] as const) {
    for (const fact of queue) {
      const nuxt = projectOf(fact)!;
      for (const item of [...fact.imports, ...fact.reExports, ...fact.dynamicImports]) {
        if (
          item.source === null ||
          ("kind" in item && item.kind === "type") ||
          ("typeOnly" in item && item.typeOnly)
        )
          continue;
        const path = server
          ? sourcePath(item.source, Object.entries(nuxt.nitroAutoImports?.aliases ?? {}))
          : undefined;
        follow(
          fact,
          path ? index.resolveFile(path) : index.resolveImport(fact, item.source),
          nuxt,
          server,
        );
      }
      await collectFile(fact, server, true);
    }
  }

  const clientFiles = new Set(clientEntries);
  const clientQueue = [...clientEntries];
  for (const file of clientQueue) {
    for (const dependency of appDependencies.get(file) ?? []) {
      if (clientFiles.has(dependency)) continue;
      clientFiles.add(dependency);
      clientQueue.push(dependency);
    }
  }
  clientParticipation.set(session, (from, to) => {
    if (
      (serverEntries.has(from) && !clientFiles.has(from)) ||
      (serverEntries.has(to) && !clientFiles.has(to))
    )
      return false;
    return undefined;
  });

  for (const fact of session.facts) {
    if (appFiles.has(fact.fileId) || serverFiles.has(fact.fileId)) continue;
    const nuxt = projectOf(fact);
    if (!nuxt) continue;
    if (hasUncertainRuntime(fact, nuxt, scanTargets.get(nuxt))) {
      const key = `${ids.get(nuxt)}:runtime`;
      const gap = gaps.get(key);
      if (gap) gap.files?.push(fact.relativePath);
      else
        gaps.set(key, {
          source: "vite-doctor/nuxt",
          message:
            "Nitro scans these files but the graph cannot establish their runtime bundle, so Doctor withheld their auto-import edges.",
          files: [fact.relativePath],
        });
      continue;
    }
    await collectFile(fact, false, false);
  }

  if (gaps.size)
    session.project.evidenceGaps = [...(session.project.evidenceGaps ?? []), ...gaps.values()];
  const order = new Map(session.facts.map((fact, position) => [fact.fileId, position]));
  return edges.sort((left, right) => order.get(left.from)! - order.get(right.from)!);
}

/**
 * References Unimport would inject an import for: unresolved runtime reads in source order. Type
 * queries are erased before Nuxt's transform runs, and a write-only target is not a read. In an
 * SFC, a `<script setup>` local lives inside `setup()`, so it cannot shadow a reference in the
 * normal `<script>`; imports from either block are hoisted and still shadow.
 */
function runtimeReads(scope: ScriptScope, setup: [number, number] | undefined): ScopeReference[] {
  const references = [...(scope.scopeManager.globalScope?.through ?? [])];
  const moduleScope = scope.scopeManager.scopes.find((item) => item.type === "module");
  if (setup && moduleScope)
    for (const variable of moduleScope.variables) {
      const setupLocal =
        variable.defs.length > 0 &&
        variable.defs.every(
          (def) => def.type !== "ImportBinding" && within(def.name.range[0], setup),
        );
      if (!setupLocal) continue;
      for (const reference of variable.references)
        if (!within(reference.identifier.range[0], setup)) references.push(reference);
    }
  const typeQueries: Array<[number, number]> = [];
  walkAstFacts(scope.ast, (node) => {
    const typed = node as { type: string; range?: [number, number] };
    if (typed.type === "TSTypeQuery" && typed.range) typeQueries.push(typed.range);
  });
  return references
    .filter(
      (reference) =>
        reference.isValueReference &&
        reference.isRead() &&
        !typeQueries.some((range) => within(reference.identifier.range[0], range)),
    )
    .sort((left, right) => left.identifier.range[0] - right.identifier.range[0]);
}

function within(offset: number, [start, end]: readonly [number, number]): boolean {
  return offset >= start && offset < end;
}

interface Registry {
  /** Auto-imported runtime names whose source is a file of the run, mapped to that file. */
  owned: Map<string, number>;
  /** A registered name its source file no longer exports, proving the registry predates edits. */
  stale?: { name: string; file: string };
}

/**
 * Mirrors Unimport's runtime import map: type entries are left out, and a later entry for a name
 * replaces an earlier one, so a class registered as both a value and a type keeps its value.
 */
function projectOwnedAutoImports(
  entries: Iterable<AutoImportEntry>,
  aliases: ReadonlyArray<[string, string | undefined]>,
  resolveFile: (absolutePath: string) => number | undefined,
  factsById: ReadonlyMap<number, FileFacts>,
): Registry {
  const runtime = new Map<string, AutoImportEntry>();
  for (const entry of entries) if (!entry.type) runtime.set(entry.as ?? entry.name, entry);
  const owned = new Map<string, number>();
  for (const [name, entry] of runtime) {
    const path = sourcePath(entry.from, aliases);
    const file = path === undefined ? undefined : resolveFile(path);
    if (file === undefined) continue;
    const fact = factsById.get(file);
    if (fact && !exportsValue(fact, entry.name))
      return { owned: new Map(), stale: { name, file: fact.relativePath } };
    owned.set(name, file);
  }
  return { owned };
}

function appAliases(nuxt: NuxtProjectInfo): Array<[string, string | undefined]> {
  return Object.entries({
    "~~": nuxt.layers[0]?.root,
    "@@": nuxt.layers[0]?.root,
    "~": nuxt.appDir,
    "@": nuxt.appDir,
    ...(nuxt.manifest?.isCurrent ? nuxt.manifest.aliases : {}),
  }).sort(([left], [right]) => right.length - left.length);
}

// A star re-export can provide any name, so it cannot disprove the registry.
function exportsValue(fact: FileFacts, name: string): boolean {
  return fact.exports.some(
    (item) => item.name === "*" || (item.name === name && item.kind !== "type"),
  );
}

function sourcePath(
  source: string,
  aliases: ReadonlyArray<[string, string | undefined]>,
): string | undefined {
  if (isAbsolute(source)) return resolve(source);
  for (const [alias, target] of aliases) {
    if (!target || (source !== alias && !source.startsWith(`${alias}/`))) continue;
    return resolve(target, source.slice(alias.length).replace(/^\//, ""));
  }
  return undefined;
}

interface SfcBlock {
  loc?: { start?: { offset?: number }; end?: { offset?: number } };
}

async function scriptSource(
  fact: FileFacts,
  handle: SourceFileHandle,
): Promise<{ text: string; dialect: ScopeDialect; setup?: [number, number] } | undefined> {
  if (fact.lang === "vue") {
    await loadSourceFile(handle);
    const descriptor = handle.sfc?.descriptor as
      | { script?: SfcBlock; scriptSetup?: SfcBlock }
      | undefined;
    if (!descriptor?.script && !descriptor?.scriptSetup) return undefined;
    const script = createVueScriptForParsing(descriptor, handle.text);
    const setup = descriptor.scriptSetup?.loc;
    return {
      text: script.text,
      dialect: script.lang === "jsx" || script.lang === "tsx" ? "tsx" : "ts",
      ...(descriptor.script &&
      typeof setup?.start?.offset === "number" &&
      typeof setup.end?.offset === "number"
        ? { setup: [setup.start.offset, setup.end.offset] as [number, number] }
        : {}),
    };
  }
  if (!["ts", "tsx", "js", "jsx"].includes(fact.lang)) return undefined;
  return { text: handle.text, dialect: scopeDialect(fact.path) };
}

function isServerFile(fact: FileFacts, nuxt: NuxtProjectInfo): boolean {
  return nuxt.layers.some((layer) =>
    fact.path.startsWith(`${resolve(layer.root, layer.serverDir ?? "server")}/`),
  );
}

function isAppEntry(fact: FileFacts, nuxt: NuxtProjectInfo): boolean {
  return [
    nuxt.appDir,
    ...nuxt.layers.flatMap((layer) => (layer.srcDir ? [layer.srcDir] : [])),
  ].some((dir) => /^(?:(?:app|error)\.vue$|layouts\/.*\.vue$)/.test(relative(dir, fact.path)));
}

function hasUncertainRuntime(
  fact: FileFacts,
  nuxt: NuxtProjectInfo,
  scanTargets: ReadonlySet<number | undefined> | undefined,
): boolean {
  const nitro = nuxt.nitroAutoImports;
  return Boolean(
    nitro?.enabled &&
    nuxt.manifest?.isCurrent &&
    !nuxt.manifest.appScanRoots.some((dir) => fact.path.startsWith(`${dir}/`)) &&
    (scanTargets?.has(fact.fileId) ||
      nitro.scanDirs?.some((dir) => fact.path.startsWith(`${dir}/`))),
  );
}

function isTransformedNitroFile(
  file: string,
  text: string,
  transform: NonNullable<NuxtProjectInfo["nitroAutoImports"]>["transform"],
): boolean {
  if (!transform) return false;
  const matches = (pattern: (typeof transform.include)[number]) =>
    "glob" in pattern
      ? picomatch(pattern.glob, { dot: true })(file)
      : matchesPattern(file, pattern);
  return (
    !transform.exclude.some(matches) &&
    transform.include.some(matches) &&
    !transform.commentsDisable.some((marker) => text.includes(marker))
  );
}

function isTransformedAppFile(fact: FileFacts, nuxt: NuxtProjectInfo): boolean {
  const transform = nuxt.manifest?.autoImportTransform;
  if (!transform) return true;
  if (transform.include.some((pattern) => matchesPattern(fact.path, pattern))) return true;
  return !transform.exclude.some((pattern) => matchesPattern(fact.path, pattern));
}

function matchesPattern(file: string, pattern: { source: string; flags: string }): boolean {
  try {
    return new RegExp(pattern.source, pattern.flags).test(file);
  } catch {
    return false;
  }
}

const missingEdgesConsequence =
  "Cycles through composables, utils, or stores that call each other without an import go unreported, and exports used only through auto-imports can be reported unused.";

function manifestFile(session: ScanSession, nuxt: NuxtProjectInfo): string {
  return relative(
    session.root,
    nuxt.manifestPath ?? join(nuxt.layers[0]?.root ?? session.root, ".nuxt/doctor.manifest.json"),
  );
}

type EvidenceGap = NonNullable<ScanSession["project"]["evidenceGaps"]>[number];

function unprovenAutoImportsGap(session: ScanSession, nuxt: NuxtProjectInfo): EvidenceGap {
  const manifest = manifestFile(session, nuxt);
  const reason = nuxt.autoImportsAuthoritative
    ? `${manifest} does not record Nuxt's resolved runtime auto-imports`
    : `${manifest} is ${nuxt.manifestPath ? "stale" : "missing"}`;
  return {
    source: "vite-doctor/nuxt",
    message: `${reason}, so Doctor cannot prove which names Nuxt auto-imports from project files, and the import graph has no auto-import edges. ${missingEdgesConsequence} Register vite-doctor/nuxt and run nuxt prepare, then rerun Doctor.`,
    files: [manifest],
  };
}

function unprovenNitroAutoImportsGap(
  session: ScanSession,
  nuxt: NuxtProjectInfo,
  verification?: "stale" | "requires-trust",
): EvidenceGap {
  const manifest = manifestFile(session, nuxt);
  let reason: string;
  if (verification === "requires-trust")
    reason = `Verifying ${manifest} requires the project's Nitro auto-import scanner`;
  else if (verification === "stale")
    reason = `Nitro's auto-import scan inputs changed or could not be read after ${manifest} captured them`;
  else if (nuxt.nitroAutoImports?.entries === undefined)
    reason = `${manifest} does not record Nitro's auto-imports`;
  else if (nuxt.nitroAutoImports.customResolver === true)
    reason = "Nitro's custom auto-import resolver can change the injected target per file";
  else if (nuxt.nitroAutoImports.authoritative)
    reason = `${manifest} does not record verified evidence for Nitro's auto-import scan or transform`;
  else reason = `${manifest} is stale`;
  const recovery =
    verification === "requires-trust"
      ? "Use the Nuxt Doctor command, or pass --host-extensions if you trust the project."
      : "Update vite-doctor and run nuxt prepare, then rerun Doctor.";
  return {
    source: "vite-doctor/nuxt",
    message: `${reason}, so Doctor cannot prove which names Nitro auto-imports into server files, and the import graph has no server auto-import edges. Cycles through server utils that call each other without an import go unreported. ${recovery}`,
    files: [manifest],
  };
}

function staleAutoImportsGap(
  session: ScanSession,
  nuxt: NuxtProjectInfo,
  stale: { name: string; file: string },
  registry: "Nuxt" | "Nitro",
): EvidenceGap {
  const manifest = manifestFile(session, nuxt);
  const scope = registry === "Nitro" ? "server auto-import edges" : "auto-import edges";
  return {
    source: "vite-doctor/nuxt",
    message: `${manifest} lists \`${stale.name}\` from ${stale.file}, which no longer exports it, so the ${registry} auto-import registry predates source edits and the import graph has no ${scope}. ${missingEdgesConsequence} Run nuxt prepare, then rerun Doctor.`,
    files: [manifest, stale.file],
  };
}
