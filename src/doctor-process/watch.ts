import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DoctorEngine } from "./engine.js";

export interface WatchOptions {
  root: string;
  /** Directories whose changes never trigger a rerun, such as the Doctor cache directory. */
  ignore: string[];
  run: () => Promise<number>;
  signal: AbortSignal;
  debounceMs?: number;
  onRerun?: (changed: string) => void;
}

const IGNORED_NAMES = new Set(["node_modules", ".git"]);

/**
 * Runs Doctor, then reruns it through the long-lived Doctor engine whenever a project file changes,
 * until `signal` aborts. Resolves with the exit code of the last completed run.
 */
export async function watchDoctorRuns(options: WatchOptions): Promise<number> {
  const engine = new DoctorEngine();
  let exitCode = await engine.enqueue(options.run);
  if (options.signal.aborted) return exitCode;

  let timer: NodeJS.Timeout | undefined;
  let pending: string | undefined;
  let running = false;
  const rerun = async () => {
    if (running || pending === undefined) return;
    const changed = pending;
    pending = undefined;
    running = true;
    options.onRerun?.(changed);
    try {
      exitCode = await engine.enqueue(options.run);
    } finally {
      running = false;
      if (pending !== undefined && !options.signal.aborted) void rerun();
    }
  };
  const root = resolve(options.root);
  const ignoredDirectories = options.ignore.map((directory) => resolve(directory));
  const ignored = (path: string) =>
    relative(root, path)
      .split(sep)
      .some((name) => IGNORED_NAMES.has(name)) ||
    ignoredDirectories.some((directory) => path === directory || path.startsWith(directory + sep));
  const watcher = watchTree(root, ignored, (path) => {
    pending = path;
    clearTimeout(timer);
    timer = setTimeout(() => void rerun(), options.debounceMs ?? 100);
  });

  await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
  clearTimeout(timer);
  watcher.close();
  await engine.idle();
  return exitCode;
}

/**
 * Watches a directory tree without entering ignored directories. Linux has no native recursive
 * watch, and Node's emulation would watch every node_modules directory.
 */
function watchTree(
  root: string,
  ignored: (path: string) => boolean,
  onChange: (path: string) => void,
): { close(): void } {
  if (process.platform === "darwin" || process.platform === "win32") {
    const watcher = watch(root, { recursive: true }, (_event, name) => {
      const path = name ? join(root, name.toString()) : root;
      if (!ignored(path)) onChange(path);
    });
    watcher.on("error", () => {});
    return watcher;
  }
  const watchers = new Map<string, FSWatcher>();
  const add = (directory: string) => {
    if (watchers.has(directory) || ignored(directory)) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(directory, (_event, name) => {
        const path = name ? join(directory, name.toString()) : directory;
        if (ignored(path)) return;
        const stats = statSync(path, { throwIfNoEntry: false });
        if (stats?.isDirectory()) add(path);
        else if (!stats) remove(path);
        onChange(path);
      });
    } catch {
      return;
    }
    watcher.on("error", () => remove(directory));
    watchers.set(directory, watcher);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) add(join(directory, entry.name));
  };
  const remove = (directory: string) => {
    for (const [path, watcher] of watchers) {
      if (path !== directory && !path.startsWith(directory + sep)) continue;
      watcher.close();
      watchers.delete(path);
    }
  };
  add(root);
  return {
    close() {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
