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
import { readCacheStatus } from "../../src/core/internal/cache-store.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { readStoreFile, writeStoreFile } from "./cache-store-file.ts";

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
const storedPaths = (root: string) =>
  Object.keys(readStoreFile(storePath(root)).index.files).sort();

// Signatures recorded within one timestamp tick of a write are not trusted, so tests that
// exercise the signature precheck wait past that window first.
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("Doctor keeps the cache for a run in one store file", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));

    expect(readdirSync(join(root, ".vite-doctor/cache"))).toEqual(["store.json"]);
    expect(storedPaths(root)).toEqual(Object.keys(files).map((path) => join(root, path)));
    expect(Object.keys(readStoreFile(storePath(root)).facts).sort()).toEqual(storedPaths(root));
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
    for (const facts of Object.values(readStoreFile(storePath(root)).facts)) {
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
  ["truncated index", (original: string) => original.slice(0, original.indexOf("\n") / 2)],
  ["truncated facts", (original: string) => original.slice(0, original.length - 10)],
  ["empty file", () => ""],
  ["null", () => "null"],
  ["primitive", () => "42"],
  ["v1 store", () => JSON.stringify({ version: 1, entries: {} })],
  [
    "unknown version",
    (original: string) => {
      const newline = original.indexOf("\n");
      return `${JSON.stringify({ ...JSON.parse(original.slice(0, newline)), version: 0 })}${original.slice(newline)}`;
    },
  ],
  [
    "files array",
    (original: string) => {
      const newline = original.indexOf("\n");
      return `${JSON.stringify({ ...JSON.parse(original.slice(0, newline)), files: [] })}${original.slice(newline)}`;
    },
  ],
  [
    "forged signature hash",
    (original: string) => {
      const newline = original.indexOf("\n");
      const index = JSON.parse(original.slice(0, newline));
      const path = Object.keys(index.signatures)[0]!;
      index.signatures[path][5] = "forged";
      return `${JSON.stringify(index)}${original.slice(newline)}`;
    },
  ],
  [
    "forged file hash",
    (original: string) => {
      const newline = original.indexOf("\n");
      const index = JSON.parse(original.slice(0, newline));
      const path = Object.keys(index.files)[0]!;
      index.files[path].hash = "forged";
      return `${JSON.stringify(index)}${original.slice(newline)}`;
    },
  ],
  [
    "unrepresentable timestamp",
    (original: string) => {
      const newline = original.indexOf("\n");
      const index = JSON.parse(original.slice(0, newline));
      index.writtenAt = 1e20;
      return `${JSON.stringify(index)}${original.slice(newline)}`;
    },
  ],
])("Doctor rebuilds a corrupt cache store: %s", async (_name, corrupt) => {
  await withProject(async (root) => {
    const initial = await runDoctor(options(root));
    const original = readFileSync(storePath(root), "utf8");
    const { facts } = readStoreFile(storePath(root));
    writeFileSync(storePath(root), corrupt(original));

    const recovered = await runDoctor(options(root));

    expect(recovered.diagnostics).toEqual(initial.diagnostics);
    expect(recovered.graph).toEqual(initial.graph);
    expect(storedPaths(root)).toEqual(Object.keys(files).map((path) => join(root, path)));
    expect(readStoreFile(storePath(root)).facts).toEqual(facts);
  });
});

test("cache status treats an unrepresentable timestamp as unreadable", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const store = readStoreFile(storePath(root));
    store.index.writtenAt = 1e20;
    writeStoreFile(storePath(root), store);

    expect(readCacheStatus(root, join(root, ".vite-doctor/cache"))).toMatchObject({
      exists: true,
      compatible: false,
    });
  });
});

test("Doctor prunes deleted files and rehashes edited ones", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const before = readStoreFile(storePath(root)).index.files;
    rmSync(join(root, "src/c.ts"));
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");

    await runDoctor(options(root));

    const after = readStoreFile(storePath(root));
    expect(Object.keys(after.index.files).sort()).toEqual([
      join(root, "src/a.ts"),
      join(root, "src/b.ts"),
    ]);
    expect(after.index.files[join(root, "src/a.ts")]!.hash).toBe(
      before[join(root, "src/a.ts")]!.hash,
    );
    expect(after.index.files[join(root, "src/b.ts")]!.hash).not.toBe(
      before[join(root, "src/b.ts")]!.hash,
    );
    expect(Object.keys(after.index.signatures)).not.toContain(join(root, "src/c.ts"));
    expect(Object.keys(after.facts).sort()).toEqual(Object.keys(after.index.files).sort());
  });
});

test("a config change keeps File Facts but replaces every Rule result", async () => {
  await withProject(
    async (root) => {
      const run = { root, framework: "vue" as const, cache: true };
      await runViteDoctor(run);
      const before = readStoreFile(storePath(root));

      await runViteDoctor({
        ...run,
        config: { rules: { "vue/template/html-button-has-type": "off" } },
      });

      const after = readStoreFile(storePath(root));
      expect(after.facts).toEqual(before.facts);
      expect(after.index.ruleKeys.length).toBeGreaterThan(0);
      expect(after.index.ruleKeys.filter((key) => before.index.ruleKeys.includes(key))).toEqual([]);
    },
    { "src/App.vue": "<template><button>Save</button></template>\n" },
  );
});

test("Doctor keeps untouched entries during a changed-files run", async () => {
  await withProject(async (root) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, ".gitignore"), ".vite-doctor\n");
    git("init");
    git("add", ".");
    git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.test", "commit", "-m", "init");
    await runDoctor(options(root));
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");

    await runDoctor({ ...options(root), changed: true });

    expect(storedPaths(root)).toEqual(Object.keys(files).map((path) => join(root, path)));
  });
});

test("a changed-files Rule subset retains untouched Rule results", async () => {
  await withProject(async (root) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, ".gitignore"), ".vite-doctor\n");
    git("init");
    git("add", ".");
    git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.test", "commit", "-m", "init");
    await runDoctor(options(root));
    const resultCount = (path: string) => {
      const { index } = readStoreFile(storePath(root));
      const file = index.files[join(root, path)]!;
      return (
        Object.keys(file.r ?? {}).length +
        (file.rs === undefined ? 0 : index.ruleSets[file.rs]!.length)
      );
    };
    const before = resultCount("src/c.ts");
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");

    await runDoctor({ ...options(root), changed: true, analyses: "graph" });
    expect(resultCount("src/c.ts")).toBe(before);
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

test("an unchanged warm run reads no source file and leaves the store untouched", async () => {
  await withProject(async (root) => {
    await settle();
    await runDoctor(options(root));
    const before = statSync(storePath(root)).mtimeMs;
    const warm = await createScanSession(options(root));
    const { parseSourceFiles } = await import("../../src/core/internal/facts.ts");
    await parseSourceFiles(warm);
    expect(warm.cache.runStats()).toMatchObject({ filesRead: 0, filesParsed: 0 });

    await runDoctor(options(root));

    expect(statSync(storePath(root)).mtimeMs).toBe(before);
  });
});

test("an edit that keeps the file size is detected by its signature", async () => {
  await withProject(async (root) => {
    await settle();
    const first = await runDoctor({ ...options(root), analyses: "graph" });
    expect(first.graph?.importEdges).toBe(1);
    writeFileSync(join(root, "src/a.ts"), "import { c } from './c'; export const a = c + 1;\n");

    const second = await runDoctor({ ...options(root), analyses: "graph" });
    const uncached = await runDoctor({ ...options(root), analyses: "graph", cache: false });

    expect(second.graph).toEqual(uncached.graph);
    expect(second.diagnostics).toEqual(uncached.diagnostics);
  });
});

test("a store written from an older snapshot never yields stale Diagnostics", async () => {
  await withProject(
    async (root) => {
      const run = { root, framework: "vue" as const, cache: true };
      const app = join(root, "src/App.vue");
      await settle();
      await runViteDoctor(run);
      // A slower run that started before the edit can finish after it and write last.
      const older = readFileSync(storePath(root), "utf8");
      writeFileSync(
        app,
        '<template><button>Save</button></template>\n<script setup lang="ts"></script>\n',
      );
      await runViteDoctor(run);
      writeFileSync(storePath(root), older);

      const next = await runViteDoctor(run);
      const uncached = await runViteDoctor({ ...run, cache: false });

      expect(next.diagnostics).toEqual(uncached.diagnostics);
      expect(next.diagnostics.map((diagnostic) => diagnostic.ruleId)).toContain(
        "vue/template/html-button-has-type",
      );
    },
    {
      "src/App.vue":
        '<template><button type="button">Save</button></template>\n<script setup lang="ts"></script>\n',
    },
  );
});

test("a contended store write is best-effort and leaves the lock and store intact", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const original = readFileSync(storePath(root), "utf8");
    const lock = join(root, `.vite-doctor/cache/.store-lock-${process.pid}-active`);
    writeFileSync(lock, "another writer");
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");

    await expect(runDoctor(options(root))).resolves.toBeDefined();

    expect(readFileSync(storePath(root), "utf8")).toBe(original);
    expect(readFileSync(lock, "utf8")).toBe("another writer");
    expect(readdirSync(join(root, ".vite-doctor/cache")).sort()).toEqual([
      `.store-lock-${process.pid}-active`,
      "store.json",
    ]);
    rmSync(lock);
    await runDoctor(options(root));
    expect(readFileSync(storePath(root), "utf8")).not.toBe(original);
    expect(existsSync(lock)).toBe(false);
  });
});

test("an abandoned store lock is recovered", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const original = readFileSync(storePath(root), "utf8");
    const namespace = String(statSync("/proc/self/ns/pid").ino);
    const lock = join(root, `.vite-doctor/cache/.store-lock-999999999-${namespace}-abandoned`);
    writeFileSync(lock, "abandoned");
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");

    await runDoctor(options(root));

    expect(readFileSync(storePath(root), "utf8")).not.toBe(original);
    expect(existsSync(lock)).toBe(false);
  });
});

test("an unrecognized store lock is never reclaimed", async () => {
  await withProject(async (root) => {
    await runDoctor(options(root));
    const original = readFileSync(storePath(root), "utf8");
    const lock = join(root, ".vite-doctor/cache/.store-lock-999999-legacy");
    writeFileSync(lock, "legacy");
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runDoctor(options(root));
    } finally {
      warning.mockRestore();
    }
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(storePath(root), "utf8")).toBe(original);
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
        await settle();
        await runDoctor(options(root));
        const modified = statSync(storePath(root)).mtimeMs;
        await runDoctor(options(root));
        expect(statSync(storePath(root)).mtimeMs).toBe(modified);
      } finally {
        warning.mockRestore();
      }
    });
  },
);

test("a store whose facts section is unreadable is rebuilt from source", async () => {
  await withProject(async (root) => {
    const initial = await runDoctor(options(root));
    const store = readStoreFile(storePath(root));
    writeStoreFile(storePath(root), { ...store, facts: { [join(root, "src/a.ts")]: { bad: 1 } } });

    const recovered = await runDoctor(options(root));

    expect(recovered.graph).toEqual(initial.graph);
    expect(recovered.diagnostics).toEqual(initial.diagnostics);
    expect(readStoreFile(storePath(root)).facts).toEqual(store.facts);
  });
});

test("a Rule subset run keeps the cached results of the Rules it did not run", async () => {
  await withProject(
    async (root) => {
      const run = { root, framework: "vue" as const, cache: true };
      const resultsFor = (path: string) => {
        const { index } = readStoreFile(storePath(root));
        const file = index.files[join(root, path)]!;
        return (
          Object.keys(file.r ?? {}).length +
          (file.rs === undefined ? 0 : index.ruleSets[file.rs]!.length)
        );
      };
      await runViteDoctor(run);
      const before = resultsFor("src/Other.vue");
      writeFileSync(join(root, "src/App.vue"), "<template><button>Edit</button></template>\n");

      await runViteDoctor({ ...run, rules: "vue/template/html-button-has-type" });

      expect(resultsFor("src/Other.vue")).toBe(before);
      await settle();
      const full = await runViteDoctor(run);
      expect(full.diagnostics).toEqual((await runViteDoctor({ ...run, cache: false })).diagnostics);
      const { lastWrite } = readStoreFile(storePath(root)).index;
      expect(lastWrite?.ruleResultsReused).toBeGreaterThan(
        lastWrite?.ruleResultsComputed as number,
      );
    },
    {
      "src/App.vue": "<template><button>Save</button></template>\n",
      "src/Other.vue": "<template><button>Open</button></template>\n",
    },
  );
});
