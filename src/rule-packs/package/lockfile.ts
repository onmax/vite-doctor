import { posix } from "node:path";
import { isMap, isScalar, parseDocument, type Node } from "yaml";
import { isRecord } from "./artifacts.js";

type DependencyMap = Record<string, string>;
type DependencyField = "dependencies" | "optionalDependencies" | "devDependencies";

/** Offsets in pnpm-lock.yaml of one dependency entry, from its key to the end of its value. */
export type LockfileSpan = readonly [start: number, end: number];

interface LockEntry {
  dependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  /** Where each dependency is written, by field and dependency name. */
  spans: Partial<Record<DependencyField, Record<string, LockfileSpan>>>;
}

export interface PnpmLockfile {
  importers: Record<string, LockEntry>;
  snapshots: Record<string, LockEntry>;
}

/** One installed copy: the dependency name code imports and the version it resolves to. */
export interface ResolvedCopy {
  name: string;
  /** The version without pnpm's peer suffix; an `npm:` alias keeps its target, `pkg@1.0.0`. */
  version: string;
  /** Dependency names from the importer to this copy, the importer path first. */
  path: string[];
  /** The lockfile entry of each step of `path` after the importer, in the same order. */
  spans: LockfileSpan[];
  /** The importer's package.json field that starts `path`. */
  field: DependencyField;
}

const FIELDS = ["dependencies", "optionalDependencies", "devDependencies"] as const;

/**
 * pnpm v9 lockfiles. pnpm 11 can prepend a document for its own config dependencies, so the
 * last document with snapshots is the project's.
 */
export function parsePnpmLockfile(text: string): PnpmLockfile | undefined {
  const documents: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const separator of text.matchAll(/^---$/gm)) {
    documents.push({ text: text.slice(offset, separator.index), offset });
    offset = separator.index + separator[0].length;
  }
  documents.push({ text: text.slice(offset), offset });
  for (const document of documents.filter((item) => /^importers:/m.test(item.text)).reverse()) {
    const parsed = parseDocument(document.text);
    if (parsed.errors.length) return undefined;
    const value: unknown = parsed.toJS();
    if (!isRecord(value) || !String(value.lockfileVersion).startsWith("9")) continue;
    const importers = parsed.get("importers", true);
    const snapshots = parsed.get("snapshots", true);
    if (!isMap(importers) || !isMap(snapshots)) continue;
    return {
      importers: normalize(importers, document),
      snapshots: normalize(snapshots, document),
    };
  }
  return undefined;
}

function normalize(
  entries: Node,
  document: { text: string; offset: number },
): Record<string, LockEntry> {
  const result: Record<string, LockEntry> = {};
  if (!isMap(entries)) return result;
  for (const item of entries.items) {
    if (!isScalar(item.key)) continue;
    const entry: LockEntry = { spans: {} };
    result[String(item.key.value)] = entry;
    if (!isMap(item.value)) continue;
    for (const field of FIELDS) {
      const dependencies: unknown = item.value.get(field, true);
      if (!isMap(dependencies)) continue;
      const versions: DependencyMap = {};
      const spans: Record<string, LockfileSpan> = {};
      for (const dependency of dependencies.items) {
        if (!isScalar(dependency.key)) continue;
        const name = String(dependency.key.value);
        const node = dependency.value;
        const version = isMap(node) ? node.get("version") : isScalar(node) ? node.value : undefined;
        if (typeof version !== "string") continue;
        versions[name] = version;
        const start = dependency.key.range?.[0];
        let end = isMap(node) || isScalar(node) ? node.range?.[1] : undefined;
        if (start === undefined || end === undefined) continue;
        while (end > start && /\s/.test(document.text[end - 1]!)) end--;
        spans[name] = [document.offset + start, document.offset + end];
      }
      entry[field] = versions;
      entry.spans[field] = spans;
    }
  }
  return result;
}

function snapshotKey(name: string, version: string): string {
  return /^\d/.test(version) || version.split("(")[0]!.includes(":")
    ? `${name}@${version}`
    : version;
}

/**
 * Every copy of the selected packages that an importer's install reaches: its own dependencies,
 * optional and development dependencies, then dependencies of each snapshot. A linked workspace
 * package contributes what its consumers get, its dependencies and optionalDependencies.
 * `linked` lists the workspace importers reached through `link:`.
 */
export function resolvedCopies(
  lockfile: PnpmLockfile,
  importer: string,
  select: (name: string) => boolean,
  includeDevelopment = true,
): { copies: ResolvedCopy[]; linked: string[] } {
  const copies = new Map<string, ResolvedCopy>();
  const linked: string[] = [];
  const seen = new Set<string>([`importer:${importer}`]);
  const entry = lockfile.importers[importer];
  if (!entry) return { copies: [], linked };
  const queue: Array<{
    from: string;
    name: string;
    version: string;
    path: string[];
    spans: LockfileSpan[];
    field: ResolvedCopy["field"];
  }> = [];
  const step = (parent: LockEntry, field: DependencyField, name: string, spans: LockfileSpan[]) => {
    const span = parent.spans[field]?.[name];
    return span ? [...spans, span] : spans;
  };
  const fields = includeDevelopment ? FIELDS : (["dependencies", "optionalDependencies"] as const);
  for (const field of fields)
    for (const [name, version] of Object.entries(entry[field] ?? {}))
      queue.push({
        from: importer,
        name,
        version,
        path: [importer, name],
        spans: step(entry, field, name, []),
        field,
      });
  for (let index = 0; index < queue.length; index++) {
    const { from, name, version, path, spans, field } = queue[index]!;
    if (version.startsWith("link:")) {
      const target = posix.normalize(posix.join(from, version.slice("link:".length)));
      if (seen.has(`importer:${target}`)) continue;
      seen.add(`importer:${target}`);
      const linkedEntry = lockfile.importers[target];
      if (!linkedEntry) continue;
      linked.push(target);
      for (const childField of ["dependencies", "optionalDependencies"] as const)
        for (const [child, childVersion] of Object.entries(linkedEntry[childField] ?? {}))
          queue.push({
            from: target,
            name: child,
            version: childVersion,
            path: [...path, child],
            spans: step(linkedEntry, childField, child, spans),
            field,
          });
      continue;
    }
    const key = snapshotKey(name, version);
    if (select(name)) {
      const copy = version.replace(/\(.*$/, "");
      const id = `${name}\0${copy}`;
      if (!copies.has(id)) copies.set(id, { name, version: copy, path, spans, field });
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = lockfile.snapshots[key];
    if (!snapshot) continue;
    for (const childField of ["dependencies", "optionalDependencies"] as const)
      for (const [child, childVersion] of Object.entries(snapshot[childField] ?? {}))
        queue.push({
          from,
          name: child,
          version: childVersion,
          path: [...path, child],
          spans: step(snapshot, childField, child, spans),
          field,
        });
  }
  return { copies: [...copies.values()], linked };
}
