import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "pathe";

export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "untracked";

export interface GitChangeHunk {
  previous: { startLine: number; lineCount: number };
  current: { startLine: number; lineCount: number };
}

export interface ChangedLineRange {
  startLine: number;
  endLine: number;
}

export interface GitChangedFile {
  kind: GitChangeKind;
  path?: string;
  previousPath?: string;
  hunks: GitChangeHunk[];
  reportRanges: ChangedLineRange[];
}

export type GitChangeUnavailableReason =
  | "git-not-found"
  | "not-a-repository"
  | "missing-head"
  | "invalid-ref"
  | "no-merge-base"
  | "git-command-failed";

export interface AvailableGitChangeInventory {
  status: "available";
  base: string | null;
  files: GitChangedFile[];
}

export interface UnavailableGitChangeInventory {
  status: "unavailable";
  reason: GitChangeUnavailableReason;
  message: string;
  ref?: string;
}

export type GitChangeInventory = AvailableGitChangeInventory | UnavailableGitChangeInventory;

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

interface TrackedChange {
  kind: Exclude<GitChangeKind, "untracked">;
  path?: string;
  previousPath?: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export async function collectGitChangeInventory(
  root: string,
  since?: string,
): Promise<GitChangeInventory> {
  const repository = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!repository.ok) {
    return unavailableInventory(
      repository.errorCode === "ENOENT" ? "git-not-found" : "not-a-repository",
      repository.errorCode === "ENOENT"
        ? "Git is not installed or is not available on PATH."
        : "The Doctor Run root is not inside a Git worktree.",
      since,
    );
  }
  if (repository.stdout.trim() !== "true") {
    return unavailableInventory(
      "not-a-repository",
      "The Doctor Run root is not inside a Git worktree.",
      since,
    );
  }

  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) {
    if (since) {
      return unavailableInventory(
        "missing-head",
        `Cannot resolve --since ${JSON.stringify(since)} because the repository has no HEAD commit.`,
        since,
      );
    }
    return collectUnbornRepositoryChanges(root);
  }

  const base = since ? await resolveMergeBase(root, since) : head.stdout.trim();
  if (typeof base !== "string") return base;
  return collectChanges(root, base, since);
}

export async function collectExternalGitChanges(
  root: string,
  base: string | null,
  files: string[],
  since?: string,
): Promise<GitChangeInventory> {
  const prefix = await runGit(root, ["rev-parse", "--show-cdup"]);
  if (!prefix.ok) {
    return unavailableInventory(
      "git-command-failed",
      commandFailureMessage("Git could not locate the worktree root", prefix),
      since,
    );
  }
  const worktree = resolve(root, prefix.stdout.trim());
  const paths = files
    .map((file) => relative(worktree, file))
    .filter((path) => path && path !== ".." && !path.startsWith("../") && !isAbsolute(path));
  if (!paths.length) return { status: "available", base, files: [] };
  const changes =
    base === null
      ? await collectUnbornRepositoryChanges(worktree, paths)
      : await collectChanges(worktree, base, since, paths);
  if (changes.status === "available") {
    for (const change of changes.files) {
      if (change.path) change.path = relative(root, resolve(worktree, change.path));
      if (change.previousPath)
        change.previousPath = relative(root, resolve(worktree, change.previousPath));
    }
  }
  return changes;
}

async function collectChanges(
  root: string,
  base: string,
  since?: string,
  paths: string[] = [],
): Promise<GitChangeInventory> {
  const tracked = await runGit(root, [
    "--literal-pathspecs",
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--relative",
    "--diff-filter=ACMRDTU",
    base,
    "--",
    ...paths,
  ]);
  if (!tracked.ok) {
    return unavailableInventory(
      "git-command-failed",
      commandFailureMessage("Git could not list changed files", tracked),
      since,
    );
  }

  const untracked = await listUntrackedFiles(root, since, paths);
  if (untracked.status === "unavailable") return untracked;

  const trackedChanges = parseNameStatus(tracked.stdout);
  const fileHunks = await mapConcurrently(trackedChanges, (change) => {
    const diffPath = change.path ?? change.previousPath;
    return diffPath
      ? collectFileHunks(
          root,
          base,
          diffPath,
          change.path && change.previousPath ? change.previousPath : undefined,
          since,
        )
      : Promise.resolve({ status: "available" as const, hunks: [] });
  });
  const changes: GitChangedFile[] = [];
  for (const [index, change] of trackedChanges.entries()) {
    const hunks = fileHunks[index]!;
    if (hunks.status === "unavailable") return hunks;
    changes.push({
      ...change,
      hunks: hunks.hunks,
      reportRanges: rangesFromHunks(hunks.hunks),
    });
  }

  for (const path of untracked.paths) {
    changes.push(wholeFileChange(root, path, "untracked"));
  }

  return {
    status: "available",
    base,
    files: sortChanges(changes),
  };
}

async function collectUnbornRepositoryChanges(
  root: string,
  selectedPaths: string[] = [],
): Promise<GitChangeInventory> {
  const cached = await runGit(root, [
    "--literal-pathspecs",
    "ls-files",
    "--cached",
    "-z",
    "--",
    ...selectedPaths,
  ]);
  if (!cached.ok) {
    return unavailableInventory(
      "git-command-failed",
      commandFailureMessage("Git could not list staged files", cached),
    );
  }
  const untracked = await listUntrackedFiles(root, undefined, selectedPaths);
  if (untracked.status === "unavailable") return untracked;

  const untrackedPaths = new Set(untracked.paths);
  const paths = [...new Set([...splitNull(cached.stdout), ...untrackedPaths])].sort();
  return {
    status: "available",
    base: null,
    files: paths.map((path) =>
      wholeFileChange(root, path, untrackedPaths.has(path) ? "untracked" : "added"),
    ),
  };
}

function wholeFileChange(root: string, path: string, kind: "added" | "untracked"): GitChangedFile {
  let hunks: GitChangeHunk[] | undefined;
  let ranges: ChangedLineRange[] | undefined;
  return {
    kind,
    path,
    get hunks() {
      if (hunks) return hunks;
      const lineCount = currentLineCount(resolve(root, path));
      return (hunks = lineCount
        ? [
            {
              previous: { startLine: 0, lineCount: 0 },
              current: { startLine: 1, lineCount },
            },
          ]
        : []);
    },
    get reportRanges() {
      return (ranges ??= rangesFromHunks(this.hunks));
    },
  };
}

async function resolveMergeBase(
  root: string,
  ref: string,
): Promise<string | UnavailableGitChangeInventory> {
  const resolved = await runGit(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (!resolved.ok) {
    return unavailableInventory(
      "invalid-ref",
      `Git ref ${JSON.stringify(ref)} does not exist.`,
      ref,
    );
  }

  const mergeBase = await runGit(root, ["merge-base", resolved.stdout.trim(), "HEAD"]);
  if (!mergeBase.ok || !mergeBase.stdout.trim()) {
    return unavailableInventory(
      "no-merge-base",
      `Git ref ${JSON.stringify(ref)} has no merge base with HEAD.`,
      ref,
    );
  }
  return mergeBase.stdout.trim();
}

async function listUntrackedFiles(
  root: string,
  ref?: string,
  paths: string[] = [],
): Promise<{ status: "available"; paths: string[] } | UnavailableGitChangeInventory> {
  const result = await runGit(root, [
    "--literal-pathspecs",
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...paths,
  ]);
  if (!result.ok) {
    return unavailableInventory(
      "git-command-failed",
      commandFailureMessage("Git could not list untracked files", result),
      ref,
    );
  }
  return { status: "available", paths: splitNull(result.stdout).sort() };
}

async function collectFileHunks(
  root: string,
  base: string,
  path: string,
  previousPath?: string,
  ref?: string,
): Promise<{ status: "available"; hunks: GitChangeHunk[] } | UnavailableGitChangeInventory> {
  const result = await runGit(root, [
    "--literal-pathspecs",
    "diff",
    "--unified=0",
    "--inter-hunk-context=0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    base,
    "--",
    ...(previousPath ? [previousPath] : []),
    path,
  ]);
  if (!result.ok) {
    return unavailableInventory(
      "git-command-failed",
      commandFailureMessage(`Git could not read changes for ${JSON.stringify(path)}`, result),
      ref,
    );
  }
  return { status: "available", hunks: parseHunks(result.stdout) };
}

export function parseGitChangeHunks(patch: string): GitChangeHunk[] {
  return parseHunks(patch);
}

function parseHunks(patch: string): GitChangeHunk[] {
  const hunks: GitChangeHunk[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = HUNK_HEADER.exec(line);
    if (!match) continue;
    hunks.push({
      previous: {
        startLine: Number(match[1]),
        lineCount: match[2] === undefined ? 1 : Number(match[2]),
      },
      current: {
        startLine: Number(match[3]),
        lineCount: match[4] === undefined ? 1 : Number(match[4]),
      },
    });
  }
  return hunks;
}

function rangesFromHunks(hunks: GitChangeHunk[]): ChangedLineRange[] {
  const ranges = hunks
    .filter((hunk) => hunk.current.lineCount > 0)
    .map((hunk) => ({
      startLine: hunk.current.startLine,
      endLine: hunk.current.startLine + hunk.current.lineCount - 1,
    }))
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);

  const merged: ChangedLineRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

// Every changed file gets its own `git diff`, and a wide diff has hundreds; a few at a time keeps
// that from dominating a --since run without flooding the machine with processes.
const GIT_DIFF_CONCURRENCY = 8;

async function mapConcurrently<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GIT_DIFF_CONCURRENCY, items.length) }, worker));
  return results;
}

function parseNameStatus(output: string): TrackedChange[] {
  const fields = splitNull(output);
  const changes: TrackedChange[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    const code = status[0];
    if (code === "R" || code === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) continue;
      changes.push({
        kind: code === "R" ? "renamed" : "copied",
        previousPath,
        path,
      });
      continue;
    }

    const changedPath = fields[index++];
    if (!changedPath) continue;
    const kind = changeKind(code);
    changes.push(
      kind === "deleted" ? { kind, previousPath: changedPath } : { kind, path: changedPath },
    );
  }
  return changes;
}

function changeKind(code: string | undefined): Exclude<GitChangeKind, "untracked"> {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "T") return "type-changed";
  if (code === "U") return "unmerged";
  return "modified";
}

function sortChanges(changes: GitChangedFile[]): GitChangedFile[] {
  return changes.sort((left, right) => {
    const leftPath = left.path ?? left.previousPath ?? "";
    const rightPath = right.path ?? right.previousPath ?? "";
    return compareText(leftPath, rightPath) || compareText(left.kind, right.kind);
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentLineCount(file: string): number {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return 0;
  const source = readFileSync(file, "utf8");
  if (!source) return 0;
  const newlineCount = source.match(/\n/g)?.length ?? 0;
  return newlineCount + (source.endsWith("\n") ? 0 : 1);
}

function splitNull(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function unavailableInventory(
  reason: GitChangeUnavailableReason,
  message: string,
  ref?: string,
): UnavailableGitChangeInventory {
  return {
    status: "unavailable",
    reason,
    message,
    ...(ref ? { ref } : {}),
  };
}

function commandFailureMessage(prefix: string, result: CommandResult): string {
  const detail = result.stderr.trim();
  return detail ? `${prefix}: ${detail}` : `${prefix}.`;
}

/**
 * Untracked paths under `root` that Git ignores, relative to `root`; ignored directories end with
 * "/". Undefined outside a Git work tree, or when `root` itself is ignored.
 */
export async function listGitIgnoredPaths(root: string): Promise<string[] | undefined> {
  const result = await runGit(root, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  if (!result.ok) return undefined;
  const paths = splitNull(result.stdout);
  return paths.some((path) => path === "./" || path.startsWith("../")) ? undefined : paths;
}

function runGit(root: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    // Path listings of large repositories exceed execFile's 1 MiB default.
    const options = { cwd: root, encoding: "utf8", maxBuffer: Infinity } as const;
    execFile("git", args, options, (error, stdout, stderr) => {
      resolvePromise({
        ok: !error,
        stdout,
        stderr,
        errorCode:
          error && "code" in error && typeof error.code === "string" ? error.code : undefined,
      });
    });
  });
}
