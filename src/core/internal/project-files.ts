import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { matchesGlob, resolve as resolveNative } from "node:path";
import { resolve } from "pathe";
import type { ProjectInfo } from "../primitives.js";

// Every file below these directories is excluded by both the source inventory and language
// detection, so the walk never needs to read them.
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "generated"]);
const SKIPPED_DIRECTORY_EXCLUDES = [...SKIPPED_DIRECTORIES].map((name) => `**/${name}/**`);
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const MAX_BRACE_EXPANSIONS = 256;

export interface ProjectEntry {
  path: string;
  name: string;
  /** Symlinked directories are listed but, like `fs.glob` through `**`, never descended. */
  kind: "file" | "directory" | "symlinked-directory" | "other";
}

/**
 * One lazy, shared walk of a project tree. Dot entries are skipped because glob patterns only
 * match them when a segment starts with an explicit dot, and those patterns fall back to
 * `fs.glob`.
 */
export class ProjectFileWalk {
  readonly root: string;
  readonly #entries: ProjectEntry[] = [];
  readonly #pending: string[] = [""];

  constructor(root: string) {
    this.root = resolve(root);
  }

  *entries(): Generator<ProjectEntry> {
    for (let index = 0; ; index++) {
      while (index >= this.#entries.length) {
        if (!this.#readNext()) return;
      }
      yield this.#entries[index]!;
    }
  }

  complete(): readonly ProjectEntry[] {
    while (this.#readNext());
    return this.#entries;
  }

  /** Non-dot entry names directly inside a directory of the walked tree. */
  children(path: string): string[] {
    try {
      return readdirSync(this.#absolute(path)).filter((name) => !name.startsWith("."));
    } catch {
      return [];
    }
  }

  #readNext(): boolean {
    const directory = this.#pending.pop();
    if (directory === undefined) return false;
    let dirents;
    try {
      dirents = readdirSync(this.#absolute(directory), { withFileTypes: true });
    } catch {
      return true;
    }
    for (const dirent of dirents) {
      const name = dirent.name;
      if (name.startsWith(".")) continue;
      const path = directory ? `${directory}/${name}` : name;
      if (dirent.isDirectory()) {
        this.#entries.push({ path, name, kind: "directory" });
        if (!SKIPPED_DIRECTORIES.has(name)) this.#pending.push(path);
      } else if (dirent.isFile()) {
        this.#entries.push({ path, name, kind: "file" });
      } else if (dirent.isSymbolicLink()) {
        this.#entries.push({ path, name, kind: this.#symlinkKind(path) });
      } else {
        this.#entries.push({ path, name, kind: "other" });
      }
    }
    return true;
  }

  #symlinkKind(path: string): ProjectEntry["kind"] {
    try {
      const stat = statSync(this.#absolute(path), { throwIfNoEntry: false });
      if (stat?.isDirectory()) return "symlinked-directory";
      return stat?.isFile() ? "file" : "other";
    } catch {
      return "other";
    }
  }

  #absolute(path: string): string {
    return path ? `${this.root === "/" ? "" : this.root}/${path}` : this.root;
  }
}

const projectWalks = new WeakMap<ProjectInfo, ProjectFileWalk>();

export function rememberProjectFileWalk(project: ProjectInfo, walk: ProjectFileWalk): void {
  projectWalks.set(project, walk);
}

/** Hands the walk started during project detection to the source inventory of the same run, once. */
export function takeProjectFileWalk(
  project: ProjectInfo,
  root: string,
): ProjectFileWalk | undefined {
  const walk = projectWalks.get(project);
  projectWalks.delete(project);
  return walk?.root === resolve(root) ? walk : undefined;
}

/**
 * Returns absolute paths of regular files (or symlinks to them) that `fs.glob(include, { cwd,
 * exclude })` would return. Patterns the walk cannot answer exactly run through `fs.glob`.
 */
export async function selectProjectFiles(
  walk: ProjectFileWalk,
  include: readonly string[],
  exclude: string[],
  memo?: WalkSelectionMemo,
): Promise<string[]> {
  const entries = walk.complete();
  const files = new Set<string>();
  const symlinkedDirectories = entries.filter((entry) => entry.kind === "symlinked-directory");
  const walked = SKIPPED_DIRECTORY_EXCLUDES.every((pattern) => exclude.includes(pattern))
    ? include.filter((pattern) => isWalkPattern(pattern, symlinkedDirectories))
    : [];
  if (walked.length) {
    const key = memo && walkSelectionKey(walk.root, entries, walked, exclude);
    const remembered = key ? memo!.selected(key) : undefined;
    if (remembered) for (const file of remembered) files.add(file);
    else {
      const matchers = walked.map((pattern) => createGlobMatcher(pattern));
      const isExcluded = createExclusion(walk.root, exclude);
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        if (!matchers.some((matches) => matches(entry.path))) continue;
        if (isExcluded(entry.path)) continue;
        files.add(resolve(walk.root, entry.path));
      }
      if (key) memo!.rememberSelected(key, [...files]);
    }
  }
  for (const pattern of include) {
    if (walked.includes(pattern)) continue;
    for await (const entry of glob(pattern, { cwd: walk.root, exclude })) {
      if (typeof entry !== "string") continue;
      const absolute = resolve(walk.root, entry);
      if (statSync(absolute, { throwIfNoEntry: false })?.isFile()) files.add(absolute);
    }
  }
  return [...files];
}

/** Glob matching is a pure function of the walk listing, so a run with the same listing reuses it. */
export interface WalkSelectionMemo {
  selected(key: string): readonly string[] | undefined;
  rememberSelected(key: string, files: string[]): void;
}

function walkSelectionKey(
  root: string,
  entries: readonly ProjectEntry[],
  include: readonly string[],
  exclude: readonly string[],
): string {
  const hash = createHash("sha256").update(JSON.stringify([root, include, exclude]));
  for (const entry of entries) hash.update(`\0${entry.kind}:${entry.path}`);
  return hash.digest("hex");
}

// `fs.glob` never descends a symlinked directory through `**`, but steps into one when the
// following segment matches its name. Patterns that could step into one, or that can match dot
// entries, stay on `fs.glob`.
function isWalkPattern(pattern: string, symlinkedDirectories: ProjectEntry[]): boolean {
  if (!pattern || pattern.startsWith("/") || /[\\()[]/.test(pattern)) return false;
  if (/(?:^|[/{,])\./.test(pattern)) return false;
  if (!symlinkedDirectories.length || !pattern.includes("/")) return true;
  const segment = /^\*\*\/([^/]*)$/.exec(pattern)?.[1];
  return (
    segment !== undefined &&
    !symlinkedDirectories.some((directory) => matchesGlob(directory.name, segment))
  );
}

// Mirrors `fs.glob` exclusion: patterns resolve against the walk root, matched directories are
// pruned (with and without a trailing slash), and files are matched by their absolute path.
function createExclusion(root: string, patterns: string[]): (path: string) => boolean {
  const matchers = patterns.map((pattern) => createGlobMatcher(resolveNative(root, pattern)));
  const prefix = root === "/" ? "/" : `${root}/`;
  const matches = (path: string) => matchers.some((matcher) => matcher(path));
  const directories = new Map<string, boolean>([["", matches(root)]]);
  const isDirectoryExcluded = (path: string): boolean => {
    let excluded = directories.get(path);
    if (excluded === undefined) {
      const slash = path.lastIndexOf("/");
      const absolute = prefix + path;
      excluded =
        isDirectoryExcluded(slash === -1 ? "" : path.slice(0, slash)) ||
        matches(absolute) ||
        matches(`${absolute}/`);
      directories.set(path, excluded);
    }
    return excluded;
  };
  return (path) => {
    const slash = path.lastIndexOf("/");
    return isDirectoryExcluded(slash === -1 ? "" : path.slice(0, slash)) || matches(prefix + path);
  };
}

/**
 * `path.matchesGlob` behind a literal-substring prefilter. Every literal fragment of a brace
 * expansion must appear in a matching path, so most paths are rejected without running the glob.
 */
export function createGlobMatcher(pattern: string): (path: string) => boolean {
  const alternatives = literalFragments(pattern);
  if (!alternatives) return (path) => matchesGlob(path, pattern);
  return (path) => {
    const candidate = CASE_INSENSITIVE ? path.toLowerCase() : path;
    return (
      alternatives.some((fragments) =>
        fragments.every((fragment) => candidate.includes(fragment)),
      ) && matchesGlob(path, pattern)
    );
  };
}

function literalFragments(pattern: string): string[][] | undefined {
  if (/[\\()[\]]|\$\{/.test(pattern)) return undefined;
  const expansions = expandBraces(pattern);
  if (!expansions) return undefined;
  const alternatives: string[][] = [];
  for (const expansion of expansions) {
    if (/[{}]/.test(expansion) || /(?:^|\/)\.\.?(?:\/|$)/.test(expansion)) return undefined;
    const fragments = expansion
      .split(/[*?/]+/)
      .filter(Boolean)
      .map((fragment) => (CASE_INSENSITIVE ? fragment.toLowerCase() : fragment));
    if (!fragments.length) return undefined;
    alternatives.push(fragments);
  }
  return alternatives;
}

function expandBraces(pattern: string): string[] | undefined {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  const commas: number[] = [];
  let depth = 0;
  let close = -1;
  for (let index = open; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      close = index;
      break;
    } else if (character === "," && depth === 1) commas.push(index);
  }
  if (close === -1 || !commas.length || pattern.slice(open, close).includes("..")) return undefined;
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const expansions: string[] = [];
  for (let index = 0; index < bounds.length - 1; index++) {
    const part = pattern.slice(bounds[index]! + 1, bounds[index + 1]);
    const expanded = expandBraces(head + part + tail);
    if (!expanded) return undefined;
    expansions.push(...expanded);
    if (expansions.length > MAX_BRACE_EXPANSIONS) return undefined;
  }
  return expansions;
}
