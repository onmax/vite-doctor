import { isAbsolute } from "node:path";
import { join, relative, resolve } from "pathe";
import type { FileFacts, NuxtProjectInfo, SourceFileHandle, SourceRange } from "../primitives.js";
import type { ScanSession } from "./scan-session.js";
import { loadSourceFile } from "./facts.js";
import { analyzeScript, scopeDialect, type ScopeDialect } from "./script-scope.js";
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

const edgesBySession = new WeakMap<ScanSession, AutoImportEdge[]>();

/** Auto-import edges collected for this run, or none when nothing asked for them. */
export function sessionAutoImportEdges(session: ScanSession): readonly AutoImportEdge[] {
  return edgesBySession.get(session) ?? [];
}

/**
 * Collects edges for unshadowed script references to Nuxt auto-imports whose source is a file of
 * the run. Auto-imports from packages (`ref`, `useFetch`) never become edges. Template references
 * are left out: rendered components are Component Usage, and template expressions are not
 * scope-analyzed. Only a current Nuxt manifest proves which names are auto-imported, so a Nuxt
 * app without one gets no auto-import edges and an evidence gap instead.
 */
export async function collectAutoImportEdges(
  session: ScanSession,
  resolveFile: (absolutePath: string) => number | undefined,
): Promise<readonly AutoImportEdge[]> {
  const cached = edgesBySession.get(session);
  if (cached) return cached;
  const edges: AutoImportEdge[] = [];
  edgesBySession.set(session, edges);
  const ownedByInventory = new Map<NuxtProjectInfo, Map<string, number>>();
  const unproven = new Set<NuxtProjectInfo>();

  for (const fact of session.facts) {
    const handle = session.handlesByPath.get(fact.path);
    const nuxt = handle?.project.nuxt;
    if (!handle || !nuxt || !nuxt.autoImportEnabled) continue;
    if (!nuxt.autoImportsAuthoritative) {
      unproven.add(nuxt);
      continue;
    }
    if (!isTransformedAppFile(fact, nuxt)) continue;
    let owned = ownedByInventory.get(nuxt);
    if (!owned) ownedByInventory.set(nuxt, (owned = projectOwnedAutoImports(nuxt, resolveFile)));
    const text = handle.text;
    const candidates = [...owned.keys()].filter((name) => text.includes(name));
    if (!candidates.length) continue;
    const script = await scriptSource(fact, handle);
    const scope = script && analyzeScript(script.text, script.dialect);
    if (!scope) continue;
    const seen = new Set<string>();
    for (const reference of scope.scopeManager.globalScope?.through ?? []) {
      const name = reference.identifier.name;
      const to = owned.get(name);
      if (to === undefined || to === fact.fileId || seen.has(name)) continue;
      if (!reference.isValueReference) continue;
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

  if (unproven.size)
    session.project.evidenceGaps = [
      ...(session.project.evidenceGaps ?? []),
      ...[...unproven].map((nuxt) => unprovenAutoImportsGap(session, nuxt)),
    ];
  return edges;
}

/** Auto-imported value names whose source is a file of the run, mapped to that file. */
function projectOwnedAutoImports(
  nuxt: NuxtProjectInfo,
  resolveFile: (absolutePath: string) => number | undefined,
): Map<string, number> {
  const owned = new Map<string, number>();
  const aliases = Object.entries({
    "~~": nuxt.layers[0]?.root,
    "@@": nuxt.layers[0]?.root,
    "~": nuxt.appDir,
    "@": nuxt.appDir,
    ...(nuxt.manifest?.isCurrent ? nuxt.manifest.aliases : {}),
  }).sort(([left], [right]) => right.length - left.length);
  for (const [name, entry] of nuxt.autoImports) {
    if (entry.type) continue;
    const path = sourcePath(entry.from, aliases);
    const file = path === undefined ? undefined : resolveFile(path);
    if (file !== undefined) owned.set(name, file);
  }
  return owned;
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

async function scriptSource(
  fact: FileFacts,
  handle: SourceFileHandle,
): Promise<{ text: string; dialect: ScopeDialect } | undefined> {
  if (fact.lang === "vue") {
    await loadSourceFile(handle);
    const descriptor = handle.sfc?.descriptor as
      | { script?: unknown; scriptSetup?: unknown }
      | undefined;
    if (!descriptor?.script && !descriptor?.scriptSetup) return undefined;
    const script = createVueScriptForParsing(descriptor, handle.text);
    return {
      text: script.text,
      dialect: script.lang === "jsx" || script.lang === "tsx" ? "tsx" : "ts",
    };
  }
  if (!["ts", "tsx", "js", "jsx"].includes(fact.lang)) return undefined;
  return { text: handle.text, dialect: scopeDialect(fact.path) };
}

// Nitro auto-imports server code from its own scan, which Nuxt's app auto-imports do not describe.
function isTransformedAppFile(fact: FileFacts, nuxt: NuxtProjectInfo): boolean {
  if (/(^|\/)server\//.test(fact.relativePath)) return false;
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

function unprovenAutoImportsGap(session: ScanSession, nuxt: NuxtProjectInfo) {
  const manifest = relative(
    session.root,
    nuxt.manifestPath ?? join(nuxt.layers[0]?.root ?? session.root, ".nuxt/doctor.manifest.json"),
  );
  return {
    source: "vite-doctor/nuxt",
    message: `${manifest} is ${nuxt.manifestPath ? "stale" : "missing"}, so Doctor cannot prove which names Nuxt auto-imports from project files, and the import graph has no auto-import edges. Cycles through composables, utils, or stores that call each other without an import go unreported, and exports used only through auto-imports can be reported unused. Register vite-doctor/nuxt and run nuxt prepare, then rerun Doctor.`,
    files: [manifest],
  };
}
