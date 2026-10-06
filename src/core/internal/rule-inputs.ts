import { globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "pathe";
import type { RuleCache, RuleDirEntry, RuleFileStat, RuleFileSystem } from "../primitives.js";

type EntryKind = "file" | "directory" | "symlink" | "other";

interface Entry {
  kind: Exclude<EntryKind, "symlink">;
  size: number;
}

/**
 * Rule inputs are the files, directory listings, and path facts Rules read through `ctx.fs`.
 * Each input has a stable id (`<kind>:<absolute path or pattern>`), and every read is answered
 * once per Doctor Run so all Rules observe the same file system.
 */
export class RuleInputs {
  readonly root: string;
  private readonly texts = new Map<string, string | undefined>();
  private readonly entries = new Map<string, Entry | undefined>();
  private readonly dirs = new Map<string, RuleDirEntry[] | undefined>();
  private readonly realpaths = new Map<string, string | undefined>();
  private readonly globs = new Map<string, string[]>();
  private readonly memory = new Map<string, unknown>();
  private readonly memoryInputs = new Map<string, readonly string[]>();
  private readonly knownText: (path: string) => string | undefined;

  constructor(root: string, knownText: (path: string) => string | undefined = () => undefined) {
    this.root = resolve(root);
    this.knownText = knownText;
  }

  /**
   * One Rule's view of the run: its reads are logged in the order they happen. A `scope` keeps
   * `ctx.cache` values apart for Rules that see a different Project Inventory, such as a Nuxt
   * workspace package with its own inventory.
   */
  frame(scope?: string): RuleInputFrame {
    return new RuleInputFrame(this, scope);
  }

  text(path: string): string | undefined {
    if (this.texts.has(path)) return this.texts.get(path);
    let text = this.knownText(path);
    if (text === undefined) {
      try {
        text = readFileSync(path, "utf8");
      } catch {
        text = undefined;
      }
    }
    this.texts.set(path, text);
    return text;
  }

  entry(path: string): Entry | undefined {
    if (this.entries.has(path)) return this.entries.get(path);
    let entry: Entry | undefined;
    try {
      const stats = statSync(path, { throwIfNoEntry: false });
      if (stats)
        entry = {
          kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
          size: stats.size,
        };
    } catch {
      entry = undefined;
    }
    this.entries.set(path, entry);
    return entry;
  }

  dir(path: string): RuleDirEntry[] | undefined {
    if (this.dirs.has(path)) return this.dirs.get(path);
    let entries: RuleDirEntry[] | undefined;
    try {
      entries = readdirSync(path, { withFileTypes: true }).map((dirent) =>
        dirEntry(
          dirent.name,
          dirent.isFile()
            ? "file"
            : dirent.isDirectory()
              ? "directory"
              : dirent.isSymbolicLink()
                ? "symlink"
                : "other",
        ),
      );
    } catch {
      entries = undefined;
    }
    this.dirs.set(path, entries);
    return entries;
  }

  realpath(path: string): string | undefined {
    if (this.realpaths.has(path)) return this.realpaths.get(path);
    let real: string | undefined;
    try {
      real = realpathSync(path);
    } catch {
      real = undefined;
    }
    this.realpaths.set(path, real);
    return real;
  }

  glob(id: string): string[] {
    let matches = this.globs.get(id);
    if (!matches) {
      const [cwd, pattern, ...exclude] = id.split("\0") as [string, string, ...string[]];
      try {
        matches = globSync(pattern, { cwd, exclude }).map((match) => resolve(cwd, match));
      } catch {
        matches = [];
      }
      this.globs.set(id, matches);
    }
    return matches;
  }

  remembered(key: string): { value: unknown; inputs: readonly string[] } | undefined {
    if (!this.memory.has(key)) return undefined;
    return { value: this.memory.get(key), inputs: this.memoryInputs.get(key) ?? [] };
  }

  remember(key: string, value: unknown, inputs: readonly string[]): void {
    this.memory.set(key, value);
    this.memoryInputs.set(key, inputs);
  }
}

export class RuleInputFrame {
  /** Input ids in read order; memory hits append the inputs of the remembered value. */
  readonly log: string[] = [];
  readonly fs: RuleFileSystem;
  readonly cache: RuleCache;
  private readonly misses = new Map<string, number>();

  constructor(
    private readonly inputs: RuleInputs,
    scope?: string,
  ) {
    this.fs = createRuleFileSystem(inputs, this.log);
    const scoped = (key: string) => (scope === undefined ? key : `${scope}\0${key}`);
    this.cache = {
      get: <T>(rawKey: string): T | undefined => {
        const key = scoped(rawKey);
        const remembered = inputs.remembered(key);
        if (!remembered) {
          if (!this.misses.has(key)) this.misses.set(key, this.log.length);
          return undefined;
        }
        for (const input of remembered.inputs) this.log.push(input);
        return remembered.value as T;
      },
      // A value is attributed the inputs read since this frame missed its key, which is where a
      // Rule computes what it is about to remember.
      set: <T>(rawKey: string, value: T): void => {
        const key = scoped(rawKey);
        const from = this.misses.get(key);
        if (from === undefined) return;
        this.misses.delete(key);
        inputs.remember(key, value, [...new Set(this.log.slice(from))]);
      },
    };
  }

  /** Unique input ids this frame depended on, in first-read order. */
  readInputs(): string[] {
    return [...new Set(this.log)];
  }
}

function createRuleFileSystem(inputs: RuleInputs, log: string[]): RuleFileSystem {
  const absolute = (path: string) => resolve(inputs.root, path);
  const entry = (path: string) => {
    log.push(`e:${path}`);
    return inputs.entry(path);
  };
  const dir = (path: string) => {
    log.push(`d:${path}`);
    return inputs.dir(path);
  };
  const text = (path: string) => {
    log.push(`t:${path}`);
    return inputs.text(path);
  };
  return {
    readText(path) {
      return text(absolute(path));
    },
    readJson(path) {
      const value = text(absolute(path));
      if (value === undefined) return undefined;
      try {
        const parsed: unknown = JSON.parse(value);
        return parsed;
      } catch {
        return undefined;
      }
    },
    exists(path) {
      return entry(absolute(path)) !== undefined;
    },
    stat(path) {
      const target = absolute(path);
      const found = entry(target);
      if (!found) return undefined;
      const stat: RuleFileStat = {
        isFile: () => found.kind === "file",
        isDirectory: () => found.kind === "directory",
        get size() {
          log.push(`z:${target}`);
          return found.size;
        },
      };
      return stat;
    },
    readDir(path) {
      return dir(absolute(path));
    },
    readDirRecursive(path) {
      const base = absolute(path);
      const top = dir(base);
      if (!top) return undefined;
      const results: string[] = [];
      const queue: Array<{ path: string; relative: string; entries: RuleDirEntry[] }> = [
        { path: base, relative: "", entries: top },
      ];
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index]!;
        for (const child of current.entries) {
          const relativePath = current.relative ? `${current.relative}/${child.name}` : child.name;
          results.push(relativePath);
          const childPath = `${current.path}/${child.name}`;
          const isDirectory =
            child.isDirectory() ||
            (child.isSymbolicLink() && entry(childPath)?.kind === "directory");
          if (!isDirectory) continue;
          const entries = dir(childPath);
          if (entries) queue.push({ path: childPath, relative: relativePath, entries });
        }
      }
      return results;
    },
    realpath(path) {
      const target = absolute(path);
      log.push(`r:${target}`);
      return inputs.realpath(target);
    },
    glob(pattern, options = {}) {
      const id = [absolute(options.cwd ?? "."), pattern, ...(options.exclude ?? [])].join("\0");
      log.push(`g:${id}`);
      return inputs.glob(id);
    },
  };
}

function dirEntry(name: string, kind: EntryKind): RuleDirEntry {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  };
}
