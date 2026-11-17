import { posix } from "node:path";
import { parse } from "yaml";
import { isRecord } from "./artifacts.js";

type DependencyMap = Record<string, string>;

interface LockEntry {
  dependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  devDependencies?: DependencyMap;
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
  /** The importer's package.json field that starts `path`. */
  field: "dependencies" | "optionalDependencies" | "devDependencies";
}

/**
 * pnpm v9 lockfiles. pnpm 11 can prepend a document for its own config dependencies, so the
 * last document with snapshots is the project's.
 */
export function parsePnpmLockfile(text: string): PnpmLockfile | undefined {
  const documents = text.split(/^---$/m).filter((document) => /^importers:/m.test(document));
  for (const document of documents.reverse()) {
    const value: unknown = parse(document);
    if (!isRecord(value) || !String(value.lockfileVersion).startsWith("9")) continue;
    if (!isRecord(value.importers) || !isRecord(value.snapshots)) continue;
    return {
      importers: normalize(value.importers),
      snapshots: normalize(value.snapshots),
    };
  }
  return undefined;
}

function normalize(entries: Record<string, unknown>): Record<string, LockEntry> {
  const result: Record<string, LockEntry> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!isRecord(value)) {
      result[key] = {};
      continue;
    }
    const entry: LockEntry = {};
    for (const field of ["dependencies", "optionalDependencies", "devDependencies"] as const) {
      const dependencies = value[field];
      if (!isRecord(dependencies)) continue;
      entry[field] = Object.fromEntries(
        Object.entries(dependencies).flatMap(([name, dependency]) => {
          const version = isRecord(dependency) ? dependency.version : dependency;
          return typeof version === "string" ? [[name, version]] : [];
        }),
      );
    }
    result[key] = entry;
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
    field: ResolvedCopy["field"];
  }> = [];
  const fields = includeDevelopment
    ? (["dependencies", "optionalDependencies", "devDependencies"] as const)
    : (["dependencies", "optionalDependencies"] as const);
  for (const field of fields)
    for (const [name, version] of Object.entries(entry[field] ?? {}))
      queue.push({ from: importer, name, version, path: [importer, name], field });
  for (let index = 0; index < queue.length; index++) {
    const { from, name, version, path, field } = queue[index]!;
    if (version.startsWith("link:")) {
      const target = posix.normalize(posix.join(from, version.slice("link:".length)));
      if (seen.has(`importer:${target}`)) continue;
      seen.add(`importer:${target}`);
      const linkedEntry = lockfile.importers[target];
      if (!linkedEntry) continue;
      linked.push(target);
      for (const dependencies of [linkedEntry.dependencies, linkedEntry.optionalDependencies])
        for (const [child, childVersion] of Object.entries(dependencies ?? {}))
          queue.push({
            from: target,
            name: child,
            version: childVersion,
            path: [...path, child],
            field,
          });
      continue;
    }
    const key = snapshotKey(name, version);
    if (select(name)) {
      const copy = version.replace(/\(.*$/, "");
      const id = `${name}\0${copy}`;
      if (!copies.has(id)) copies.set(id, { name, version: copy, path, field });
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = lockfile.snapshots[key];
    if (!snapshot) continue;
    for (const dependencies of [snapshot.dependencies, snapshot.optionalDependencies])
      for (const [child, childVersion] of Object.entries(dependencies ?? {}))
        queue.push({ from, name: child, version: childVersion, path: [...path, child], field });
  }
  return { copies: [...copies.values()], linked };
}
