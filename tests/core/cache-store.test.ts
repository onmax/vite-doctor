import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test, vi } from "vite-plus/test";
import { createScanSession } from "../../src/core/internal/scan-session.ts";
import { cleanCache, runDoctor } from "../../src/core/index.ts";

const files = {
  "src/a.ts": "import { b } from './b'; export const a = b + 1;\n",
  "src/b.ts": "export const b = 1;\n",
  "src/c.ts": "export function c(value: number) { return value > 1 ? value : 0; }\n",
};

async function withProject(
  run: (root: string) => Promise<void>,
  extraFiles: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "doctor-cache-store-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(root, "src"));
    for (const [path, source] of Object.entries({ ...files, ...extraFiles }))
      writeFileSync(join(root, path), source);
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const options = (root: string) => ({
  root,
  framework: "vite" as const,
  cache: true,
  analyses: "graph,dupes,health",
});

const storePath = (root: string) => join(root, ".vite-doctor/cache/store.json");

type StoredFacts = { path: string } & Record<string, unknown>;

function storedFacts(root: string): Array<[string, StoredFacts]> {
  const store = JSON.parse(readFileSync(storePath(root), "utf8"));
  return Object.entries(store.entries) as Array<[string, StoredFacts]>;
}

function storedPaths(root: string): string[] {
  return storedFacts(root)
    .map(([, facts]) => facts.path)
    .sort();
}

test("Doctor keeps File Facts for a run in one store file", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));

    expect(readdirSync(join(root, ".vite-doctor/cache"))).toEqual(["store.json"]);
    expect(storedPaths(root)).toEqual(Object.keys(files).map((path) => join(root, path)));
  });
});

test("File Facts leave duplication and health facts to their analyses", async () => {
  const branches = "if (n) console.log(n);".repeat(20);
  const clones = {
    "src/first.ts": `export function first(n: number) { ${branches} }\n`,
    "src/second.ts": `export function second(n: number) { ${branches} }\n`,
  };
  await withProject(async (root) => {
    const analyses = { ...options(root), analyses: "dupes,health" };
    const uncached = await runDoctor({ ...analyses, cache: false });
    await runDoctor({ ...options(root), analyses: undefined });
    for (const [, facts] of storedFacts(root)) {
      expect(facts).not.toHaveProperty("tokens");
      expect(facts).not.toHaveProperty("complexity");
    }

    const cached = await runDoctor(analyses);

    expect(cached.diagnostics).toEqual(uncached.diagnostics);
    expect(cached.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(
      expect.arrayContaining([
        "workspace/duplication/exact-clone",
        "workspace/health/high-cyclomatic-complexity",
      ]),
    );
  }, clones);
});

test.each([
  ["truncated JSON", (original: string) => original.slice(0, original.length / 2)],
  ["empty file", () => ""],
  ["null", () => "null"],
  ["primitive", () => "42"],
  ["missing entries", () => JSON.stringify({ version: 1 })],
  [
    "unknown version",
    (original: string) => JSON.stringify({ ...JSON.parse(original), version: 0 }),
  ],
  ["entries array", () => JSON.stringify({ version: 1, entries: [] })],
])("Doctor rebuilds a corrupt cache store: %s", async (_name, corrupt) => {
  await withProject(async (root) => {
    const initial = await runDoctor(options(root));
    const original = readFileSync(storePath(root), "utf8");
    writeFileSync(storePath(root), corrupt(original));

    const recovered = await runDoctor(options(root));

    expect(recovered.diagnostics).toEqual(initial.diagnostics);
    expect(recovered.graph).toEqual(initial.graph);
    expect(readFileSync(storePath(root), "utf8")).toBe(original);
  });
});

test("Doctor prunes File Facts for deleted and edited files", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const before = new Map(storedFacts(root).map(([key, facts]) => [facts.path, key]));
    rmSync(join(root, "src/c.ts"));
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");

    await runDoctor(options(root));

    expect(storedPaths(root)).toEqual([join(root, "src/a.ts"), join(root, "src/b.ts")]);
    const after = new Map(storedFacts(root).map(([key, facts]) => [facts.path, key]));
    expect(after.get(join(root, "src/a.ts"))).toBe(before.get(join(root, "src/a.ts")));
    expect(after.get(join(root, "src/b.ts"))).not.toBe(before.get(join(root, "src/b.ts")));
  });
});

test("Doctor invalidates File Facts when rule configuration changes", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const before = storedFacts(root).map(([key]) => key);

    await runDoctor({
      ...options(root),
      config: { rules: { "workspace/duplication/exact-clone": "off" } },
    });

    const after = storedFacts(root).map(([key]) => key);
    expect(after).toHaveLength(before.length);
    expect(after.filter((key) => before.includes(key))).toEqual([]);
  });
});

test("Doctor keeps untouched File Facts during a changed-files run", async () => {
  await withProject(async (root) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, ".gitignore"), ".vite-doctor\n");
    git("init");
    git("add", ".");
    git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.test", "commit", "-m", "init");
    await runDoctor(options(root));
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");

    await runDoctor({ ...options(root), changed: true });

    const paths = storedPaths(root);
    expect(paths).toEqual(
      expect.arrayContaining(Object.keys(files).map((path) => join(root, path))),
    );
    expect(paths.filter((path) => path === join(root, "src/b.ts"))).toHaveLength(2);
  });
});

test("cache clean removes the cache store", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    expect(existsSync(storePath(root))).toBe(true);

    cleanCache(root);

    expect(existsSync(join(root, ".vite-doctor/cache"))).toBe(false);
  });
});

test.each([true, false])(
  "overlapping full and partial runs preserve concurrent changes (full first: %s)",
  async (fullFirst) => {
    await withProject(async (root) => {
      const seed = (await createScanSession(options(root))).cache;
      seed.set("fileFacts:obsolete", { value: "old" });
      seed.set("fileFacts:updated", { value: "old" });
      seed.set("fileFacts:kept", { value: "kept" });
      seed.persist({ prune: false });
      const full = (await createScanSession(options(root))).cache;
      const partial = (await createScanSession(options(root))).cache;
      full.get("fileFacts:kept");
      partial.set("fileFacts:new", { value: "new" });
      partial.set("fileFacts:updated", { value: "new" });
      if (fullFirst) {
        full.persist({ prune: true });
        partial.persist({ prune: false });
      } else {
        partial.persist({ prune: false });
        full.persist({ prune: true });
      }
      expect(JSON.parse(readFileSync(storePath(root), "utf8")).entries).toEqual({
        "fileFacts:kept": { value: "kept" },
        "fileFacts:updated": { value: "new" },
        "fileFacts:new": { value: "new" },
      });
    });
  },
);

test("a warm run leaves the store untouched and an empty full run prunes it", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const before = statSync(storePath(root));
    await runDoctor(options(root));
    expect(statSync(storePath(root)).mtimeMs).toBe(before.mtimeMs);
    const session = await createScanSession(options(root));
    session.cache.persist({ prune: true });
    expect(JSON.parse(readFileSync(storePath(root), "utf8")).entries).toEqual({});
  });
});

test("a contended store write is best-effort and leaves the lock and store intact", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const original = readFileSync(storePath(root), "utf8");
    const lock = join(root, `.vite-doctor/cache/.store-lock-${process.pid}-active`);
    writeFileSync(lock, "another writer");
    const session = await createScanSession(options(root));
    session.cache.set("fileFacts:new", { value: "new" });
    expect(() => session.cache.persist({ prune: false })).not.toThrow();
    expect(readFileSync(storePath(root), "utf8")).toBe(original);
    expect(readFileSync(lock, "utf8")).toBe("another writer");
    expect(readdirSync(join(root, ".vite-doctor/cache")).sort()).toEqual([
      `.store-lock-${process.pid}-active`,
      "store.json",
    ]);
    rmSync(lock);
    session.cache.persist({ prune: false });
    expect(JSON.parse(readFileSync(storePath(root), "utf8")).entries["fileFacts:new"]).toEqual({
      value: "new",
    });
    expect(existsSync(lock)).toBe(false);
  });
});

test("an abandoned store lock is recovered", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const namespace = String(statSync("/proc/self/ns/pid").ino);
    const lock = join(root, `.vite-doctor/cache/.store-lock-999999999-${namespace}-abandoned`);
    writeFileSync(lock, "abandoned");
    const session = await createScanSession(options(root));
    session.cache.set("fileFacts:recovered", { value: "ok" });
    session.cache.persist({ prune: false });
    expect(
      JSON.parse(readFileSync(storePath(root), "utf8")).entries["fileFacts:recovered"],
    ).toEqual({
      value: "ok",
    });
    expect(existsSync(lock)).toBe(false);
  });
});

test("an unrecognized store lock is never reclaimed", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const lock = join(root, ".vite-doctor/cache/.store-lock-999999-legacy");
    writeFileSync(lock, "legacy");
    const session = await createScanSession(options(root));
    session.cache.set("fileFacts:blocked", { value: "no" });
    session.cache.persist({ prune: false });
    expect(existsSync(lock)).toBe(true);
    expect(
      JSON.parse(readFileSync(storePath(root), "utf8")).entries["fileFacts:blocked"],
    ).toBeUndefined();
  });
});

test.each([".store.lock", ".store-lock-999999-legacy", ".store-lock-999999-unknown-claim"])(
  "explicit upgrade cleanup restores persistence after %s",
  async (name) => {
    await withProject(async (root) => {
      await runDoctor(options(root));
      const original = readFileSync(storePath(root), "utf8");
      const lock = join(root, ".vite-doctor/cache", name);
      writeFileSync(lock, "");
      writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const blocked = await runDoctor(options(root));
        expect(readFileSync(storePath(root), "utf8")).toBe(original);
        expect(existsSync(lock)).toBe(true);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("stop all Doctor processes sharing this cache"),
        );
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("vite-doctor cache clean"));

        cleanCache(root);
        const recovered = await runDoctor(options(root));
        expect(existsSync(lock)).toBe(false);
        expect(readFileSync(storePath(root), "utf8")).not.toBe(original);
        expect(recovered.diagnostics).toEqual(blocked.diagnostics);
        expect(recovered.graph).toEqual(blocked.graph);
        expect(storedPaths(root)).toEqual(
          Object.keys(files)
            .map((path) => join(root, path))
            .sort(),
        );
        const modified = statSync(storePath(root)).mtimeMs;
        await runDoctor(options(root));
        expect(statSync(storePath(root)).mtimeMs).toBe(modified);
      } finally {
        warning.mockRestore();
      }
    });
  },
);
