import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import type { ProjectInfo } from "../../src/core/primitives.ts";
import {
  GitChangeUnavailableError,
  selectScanFiles,
  selectSourceInventory,
} from "../../src/core/internal/source-inventory.ts";
import { parseGitChangeHunks } from "../../src/core/internal/git-change-ranges.ts";

const vueProject: ProjectInfo = {
  root: "",
  framework: "vue",
  ssr: false,
  vueVersion: "3.5.0",
  isMonorepo: false,
};

test("changed source inventory includes staged, unstaged, untracked, renamed, and deleted paths", async () => {
  await withGitFixture(
    {
      "src/deleted.ts": "const deleted = true\n",
      "src/old-name.ts": "const renamed = true\n",
      "src/staged file.ts": "const first = true\nconst staged = false\nconst third = true\n",
      "src/unstaged.ts": "const first = true\nconst second = true\nconst unstaged = false\n",
      "src/unchanged.ts": "const unchanged = true\n",
      "tests/ignored.test.ts": "const ignored = false\n",
    },
    async (root) => {
      write(
        root,
        "src/staged file.ts",
        "const first = true\nconst staged = true\nconst third = true\n",
      );
      git(root, "add", "src/staged file.ts");
      write(
        root,
        "src/unstaged.ts",
        "const first = true\nconst second = true\nconst unstaged = true\n",
      );
      write(root, "src/untracked.ts", "const one = true\nconst two = true\n");
      write(root, "tests/ignored.test.ts", "const ignored = true\n");
      git(root, "mv", "src/old-name.ts", "src/new-name.ts");
      rmSync(join(root, "src/deleted.ts"));

      const selection = await selectSourceInventory(
        root,
        {},
        { changed: true },
        { ...vueProject, root },
      );

      expect(selection.git?.status).toBe("available");
      expect(selection.files.map((file) => file.displayPath)).toEqual([
        "src/new-name.ts",
        "src/staged file.ts",
        "src/unstaged.ts",
        "src/untracked.ts",
      ]);
      expect(
        selection.files.map((file) => [file.displayPath, file.reportEligibility?.ranges]),
      ).toEqual([
        ["src/new-name.ts", []],
        ["src/staged file.ts", [{ startLine: 2, endLine: 2 }]],
        ["src/unstaged.ts", [{ startLine: 3, endLine: 3 }]],
        ["src/untracked.ts", [{ startLine: 1, endLine: 2 }]],
      ]);
      if (selection.git?.status !== "available") throw new Error("Expected Git inventory.");
      expect(selection.git.files).toContainEqual({
        kind: "deleted",
        previousPath: "src/deleted.ts",
        hunks: [
          {
            previous: { startLine: 1, lineCount: 1 },
            current: { startLine: 0, lineCount: 0 },
          },
        ],
        reportRanges: [],
      });
      expect(selection.git.files).toContainEqual({
        kind: "renamed",
        previousPath: "src/old-name.ts",
        path: "src/new-name.ts",
        hunks: [],
        reportRanges: [],
      });
    },
  );
});

test("since compares HEAD and the worktree with the ref merge base", async () => {
  await withGitFixture(
    {
      "src/app.ts": "const first = true\nconst feature = false\n",
      "src/comparison.ts": "const comparison = false\n",
    },
    async (root) => {
      const mergeBase = gitText(root, "rev-parse", "HEAD");
      git(root, "branch", "comparison");
      write(root, "src/app.ts", "const first = true\nconst feature = true\n");
      git(root, "add", ".");
      commit(root, "feature");

      git(root, "checkout", "comparison");
      write(root, "src/comparison.ts", "const comparison = true\n");
      git(root, "add", ".");
      commit(root, "comparison");
      git(root, "checkout", "-");

      const selection = await selectSourceInventory(
        root,
        {},
        { since: "comparison" },
        { ...vueProject, root },
      );

      expect(selection.git?.status).toBe("available");
      if (selection.git?.status !== "available") throw new Error("Expected Git inventory.");
      expect(selection.git.base).toBe(mergeBase);
      expect(selection.files.map((file) => file.displayPath)).toEqual(["src/app.ts"]);
      expect(selection.files[0]?.reportEligibility?.ranges).toEqual([{ startLine: 2, endLine: 2 }]);
    },
  );
});

test("changed source inventory treats every file as added before the first commit", async () => {
  await withFixture({ "src/staged.ts": "const staged = true\n" }, async (root) => {
    git(root, "init");
    git(root, "add", "src/staged.ts");
    write(root, "src/untracked.ts", "const untracked = true\n");

    const selection = await selectSourceInventory(
      root,
      {},
      { changed: true },
      { ...vueProject, root },
    );

    expect(selection.git).toMatchObject({ status: "available", base: null });
    expect(selection.files.map((file) => file.displayPath)).toEqual([
      "src/staged.ts",
      "src/untracked.ts",
    ]);
    expect(
      selection.files.every((file) => file.reportEligibility?.ranges[0]?.startLine === 1),
    ).toBe(true);
  });
});

test("Git-unavailable scope is explicit and cannot look like a clean file selection", async () => {
  await withFixture({ "src/app.ts": "const app = true\n" }, async (root) => {
    const selection = await selectSourceInventory(
      root,
      {},
      { changed: true },
      { ...vueProject, root },
    );

    expect(selection).toMatchObject({
      files: [],
      git: { status: "unavailable", reason: "not-a-repository" },
    });
    await expect(
      selectScanFiles(root, {}, { changed: true }, { ...vueProject, root }),
    ).rejects.toBeInstanceOf(GitChangeUnavailableError);
  });
});

test("an invalid since ref reports the ref and a stable reason", async () => {
  await withGitFixture({ "src/app.ts": "const app = true\n" }, async (root) => {
    const selection = await selectSourceInventory(
      root,
      {},
      { since: "missing-branch" },
      { ...vueProject, root },
    );

    expect(selection).toMatchObject({
      files: [],
      git: {
        status: "unavailable",
        reason: "invalid-ref",
        ref: "missing-branch",
      },
    });
  });
});

test("Git hunk parsing preserves deletion-only changes", () => {
  expect(parseGitChangeHunks("@@ -4,2 +3,0 @@ const before = true\n-old\n-lines\n")).toEqual([
    {
      previous: { startLine: 4, lineCount: 2 },
      current: { startLine: 3, lineCount: 0 },
    },
  ]);
});

async function withGitFixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  await withFixture(files, async (root) => {
    git(root, "init");
    git(root, "add", ".");
    commit(root, "fixture");
    await run(root);
  });
}

async function withFixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-source-inventory-"));
  try {
    for (const [file, source] of Object.entries(files)) write(root, file, source);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function write(root: string, file: string, source: string) {
  const absolute = join(root, file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
}

function commit(root: string, message: string) {
  git(
    root,
    "-c",
    "user.name=Doctor",
    "-c",
    "user.email=doctor@example.com",
    "commit",
    "-m",
    message,
  );
}

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function gitText(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
