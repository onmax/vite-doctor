import { isAbsolute } from "node:path";
import { join, relative, resolve } from "pathe";
import type {
  AutoImportEntry,
  FileFacts,
  NuxtProjectInfo,
  SourceFileHandle,
  SourceRange,
} from "../primitives.js";
import type { ScanSession } from "./scan-session.js";
import { loadSourceFile, walkAstFacts } from "./facts.js";
import {
  analyzeScript,
  scopeDialect,
  type ScopeDialect,
  type ScopeReference,
  type ScriptScope,
} from "./script-scope.js";
import { createVueScriptForParsing } from "./sfc.js";

/** A file reading a binding that Nuxt auto-imports from another source file of the run. */
export interface AutoImportEdge {
  from: number;
  to: number;
  /** The auto-imported identifier, such as `useCart`. */
  name: string;
  /** The file's first unshadowed reference to `name`. */
  range: SourceRange;
}

const edgesBySession = new WeakMap<ScanSession, Promise<readonly AutoImportEdge[]>>();
const completedEdges = new WeakMap<ScanSession, readonly AutoImportEdge[]>();

/** Auto-import edges collected for this run, or none when nothing asked for them. */
export function sessionAutoImportEdges(session: ScanSession): readonly AutoImportEdge[] {
  return completedEdges.get(session) ?? [];
}

/**
 * Collects edges for unshadowed runtime reads of Nuxt auto-imports whose source is a file of the
 * run. Auto-imports from packages (`ref`, `useFetch`) never become edges. Template references
 * are left out: rendered components are Component Usage, and template expressions are not
 * scope-analyzed. Only a current Nuxt manifest proves which names are auto-imported, so a Nuxt
 * app without one, or whose manifest lists an export its file no longer has, gets no auto-import
 * edges and an evidence gap instead. Concurrent callers share one collection.
 */
export function collectAutoImportEdges(
  session: ScanSession,
  resolveFile: (absolutePath: string) => number | undefined,
): Promise<readonly AutoImportEdge[]> {
  let pending = edgesBySession.get(session);
  if (!pending) {
    pending = collect(session, resolveFile).then((edges) => {
      completedEdges.set(session, edges);
      return edges;
    });
    edgesBySession.set(session, pending);
  }
  return pending;
}

async function collect(
  session: ScanSession,
  resolveFile: (absolutePath: string) => number | undefined,
): Promise<readonly AutoImportEdge[]> {
  const edges: AutoImportEdge[] = [];
  const registries = new Map<NuxtProjectInfo, Registry>();
  const gaps = new Map<NuxtProjectInfo, ReturnType<typeof unprovenAutoImportsGap>>();
  const factsById = new Map(session.facts.map((fact) => [fact.fileId, fact]));

  for (const fact of session.facts) {
    const handle = session.handlesByPath.get(fact.path);
    const nuxt = handle?.project.nuxt;
    if (!handle || !nuxt || !nuxt.autoImportEnabled) continue;
    if (!nuxt.autoImportsAuthoritative) {
      if (!gaps.has(nuxt)) gaps.set(nuxt, unprovenAutoImportsGap(session, nuxt));
      continue;
    }
    let registry = registries.get(nuxt);
    if (!registry) {
      registry = projectOwnedAutoImports(nuxt, resolveFile, factsById);
      registries.set(nuxt, registry);
      if (registry.stale) gaps.set(nuxt, staleAutoImportsGap(session, nuxt, registry.stale));
    }
    if (registry.stale || !isTransformedAppFile(fact, nuxt)) continue;
    const owned = registry.owned;
    const text = handle.text;
    // A Unicode escape can spell a registered name without its literal text.
    if (!text.includes("\\u") && ![...owned.keys()].some((name) => text.includes(name))) continue;
    const script = await scriptSource(fact, handle);
    const scope = script && analyzeScript(script.text, script.dialect);
    if (!scope) continue;
    const seen = new Set<string>();
    for (const reference of runtimeReads(scope, script.setup)) {
      const name = reference.identifier.name;
      const to = owned.get(name);
      if (to === undefined || to === fact.fileId || seen.has(name)) continue;
      seen.add(name);
      const [start, end] = reference.identifier.range;
      edges.push({
        from: fact.fileId,
        to,
        name,
        range: session.helpers.rangeFromOffsets(fact.path, text, start, end),
      });
    }
  }

  if (gaps.size)
    session.project.evidenceGaps = [...(session.project.evidenceGaps ?? []), ...gaps.values()];
  return edges;
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
  nuxt: NuxtProjectInfo,
  resolveFile: (absolutePath: string) => number | undefined,
  factsById: ReadonlyMap<number, FileFacts>,
): Registry {
  const runtime = new Map<string, AutoImportEntry>();
  for (const entry of nuxt.autoImportEntries ?? nuxt.autoImports.values())
    if (!entry.type) runtime.set(entry.as ?? entry.name, entry);
  const owned = new Map<string, number>();
  const aliases = Object.entries({
    "~~": nuxt.layers[0]?.root,
    "@@": nuxt.layers[0]?.root,
    "~": nuxt.appDir,
    "@": nuxt.appDir,
    ...(nuxt.manifest?.isCurrent ? nuxt.manifest.aliases : {}),
  }).sort(([left], [right]) => right.length - left.length);
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

// Nitro auto-imports server code from its own scan, which Nuxt's app auto-imports do not describe.
function isTransformedAppFile(fact: FileFacts, nuxt: NuxtProjectInfo): boolean {
  const serverDirs = nuxt.layers.map((layer) => resolve(layer.root, layer.serverDir ?? "server"));
  if (serverDirs.some((dir) => fact.path.startsWith(`${dir}/`))) return false;
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

function unprovenAutoImportsGap(session: ScanSession, nuxt: NuxtProjectInfo) {
  const manifest = manifestFile(session, nuxt);
  return {
    source: "vite-doctor/nuxt",
    message: `${manifest} is ${nuxt.manifestPath ? "stale" : "missing"}, so Doctor cannot prove which names Nuxt auto-imports from project files, and the import graph has no auto-import edges. ${missingEdgesConsequence} Register vite-doctor/nuxt and run nuxt prepare, then rerun Doctor.`,
    files: [manifest],
  };
}

function staleAutoImportsGap(
  session: ScanSession,
  nuxt: NuxtProjectInfo,
  stale: { name: string; file: string },
) {
  const manifest = manifestFile(session, nuxt);
  return {
    source: "vite-doctor/nuxt",
    message: `${manifest} lists \`${stale.name}\` from ${stale.file}, which no longer exports it, so the auto-import registry predates source edits and the import graph has no auto-import edges. ${missingEdgesConsequence} Run nuxt prepare, then rerun Doctor.`,
    files: [manifest, stale.file],
  };
}
