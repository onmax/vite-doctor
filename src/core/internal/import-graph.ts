import { resolve } from "pathe";
import type { FileFacts, ImportCycle, ImportGraph, ImportGraphEdge } from "../primitives.js";

// Breadth-first searches from every member of a huge cycle group would cost
// members x edges, so the search for the shortest loop stops trying start files after this many.
const MAX_CYCLE_START_FILES = 200;

export function buildImportGraph(
  root: string,
  facts: readonly FileFacts[],
  resolveImport: (from: FileFacts, specifier: string) => number | undefined,
  autoImports: readonly ImportGraphEdge[] = [],
): ImportGraph {
  const pathsById = new Map(facts.map((fact) => [fact.fileId, fact.path]));
  const edges: ImportGraphEdge[] = [];
  const importsByFile = new Map<string, ImportGraphEdge[]>();
  const importersByFile = new Map<string, ImportGraphEdge[]>();

  const add = (fact: FileFacts, edge: Omit<ImportGraphEdge, "from" | "to">) => {
    const target = resolveImport(fact, edge.specifier);
    const to = target === undefined ? undefined : pathsById.get(target);
    const full: ImportGraphEdge = { from: fact.path, ...(to ? { to } : {}), ...edge };
    edges.push(full);
    push(importsByFile, fact.path, full);
    if (to) push(importersByFile, to, full);
  };

  for (const fact of facts) {
    for (const item of fact.imports) {
      add(fact, {
        specifier: item.source,
        kind: "import",
        typeOnly: item.kind === "type",
        range: item.range,
      });
    }
    // `export { a, b } from` yields one ExportFact per name; it is still one dependency.
    const reExports = new Set<string>();
    for (const item of fact.exports) {
      if (!item.source) continue;
      const typeOnly = item.kind === "type";
      const key = `${typeOnly}\0${item.source}`;
      if (reExports.has(key)) continue;
      reExports.add(key);
      add(fact, { specifier: item.source, kind: "re-export", typeOnly, range: item.range });
    }
    for (const item of fact.dynamicImports) {
      if (item.source === null) continue;
      add(fact, {
        specifier: item.source,
        kind: "dynamic-import",
        typeOnly: false,
        range: item.range,
      });
    }
  }

  for (const edge of autoImports) {
    edges.push(edge);
    push(importsByFile, edge.from, edge);
    if (edge.to) push(importersByFile, edge.to, edge);
  }

  const files = facts.map((fact) => fact.path);
  return {
    files,
    edges,
    importsOf: (file) => importsByFile.get(resolve(root, file)) ?? [],
    importersOf: (file) => importersByFile.get(resolve(root, file)) ?? [],
    cycles: findImportCycles(files, edges),
  };
}

/** Whether the edge makes its target evaluate before the importing module. */
export function isRuntimeImportEdge(edge: ImportGraphEdge): boolean {
  return !edge.typeOnly && edge.kind !== "dynamic-import";
}

function findImportCycles(
  files: readonly string[],
  edges: readonly ImportGraphEdge[],
): ImportCycle[] {
  const successors = new Map<string, ImportGraphEdge[]>();
  for (const edge of edges) {
    if (!edge.to || edge.to === edge.from || !isRuntimeImportEdge(edge)) continue;
    push(successors, edge.from, edge);
  }
  const components = computeSccs(files, (file) =>
    (successors.get(file) ?? []).map((edge) => edge.to!),
  );
  const cycles: ImportCycle[] = [];
  for (const component of components) {
    if (component.length < 2) continue;
    const members = [...component].sort();
    cycles.push({ files: members, path: shortestLoop(members, successors) });
  }
  return cycles.sort((a, b) => (a.files[0]! < b.files[0]! ? -1 : 1));
}

/** The shortest loop in a strongly connected group, starting at the earliest file that lies on one. */
function shortestLoop(
  members: readonly string[],
  successors: ReadonlyMap<string, ImportGraphEdge[]>,
): ImportGraphEdge[] {
  const inGroup = new Set(members);
  let best: ImportGraphEdge[] | undefined;
  for (const start of members.slice(0, MAX_CYCLE_START_FILES)) {
    const loop = shortestLoopThrough(start, inGroup, successors, best?.length);
    if (loop && (!best || loop.length < best.length)) best = loop;
    if (best?.length === 2) break;
  }
  return best ?? [];
}

function shortestLoopThrough(
  start: string,
  inGroup: ReadonlySet<string>,
  successors: ReadonlyMap<string, ImportGraphEdge[]>,
  shorterThan = Infinity,
): ImportGraphEdge[] | undefined {
  const via = new Map<string, ImportGraphEdge>();
  let frontier = [start];
  for (let depth = 1; frontier.length && depth < shorterThan; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const edge of successors.get(file) ?? []) {
        const target = edge.to!;
        if (!inGroup.has(target)) continue;
        if (target === start) {
          const loop = [edge];
          for (let at = file; at !== start;) {
            const previous = via.get(at)!;
            loop.unshift(previous);
            at = previous.from;
          }
          return loop;
        }
        if (via.has(target)) continue;
        via.set(target, edge);
        next.push(target);
      }
    }
    frontier = next;
  }
  return undefined;
}

/** Tarjan's strongly connected components, in the order they complete. */
export function computeSccs<T>(nodes: Iterable<T>, successorsOf: (node: T) => Iterable<T>): T[][] {
  let index = 0;
  const stack: T[] = [];
  const onStack = new Set<T>();
  const indices = new Map<T, number>();
  const lowlinks = new Map<T, number>();
  const components: T[][] = [];
  const strongConnect = (node: T) => {
    indices.set(node, index);
    lowlinks.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);
    for (const next of successorsOf(node)) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlinks.set(node, Math.min(lowlinks.get(node)!, lowlinks.get(next)!));
      } else if (onStack.has(next)) {
        lowlinks.set(node, Math.min(lowlinks.get(node)!, indices.get(next)!));
      }
    }
    if (lowlinks.get(node) === indices.get(node)) {
      const component: T[] = [];
      let next: T | undefined;
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

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
