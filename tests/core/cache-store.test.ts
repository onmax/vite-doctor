import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { cleanCache, runDoctor } from "../../src/core/index.ts";

const files = {
  "src/a.ts": "import { b } from './b'; export const a = b + 1;\n",
  "src/b.ts": "export const b = 1;\n",
  "src/c.ts": "export function c(value: number) { return value > 1 ? value : 0; }\n",
};

async function withProject(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-cache-store-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(root, "src"));
    for (const [path, source] of Object.entries(files)) writeFileSync(join(root, path), source);
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

type StoredFacts = { path: string; tokens: Record<string, unknown> };

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
    for (const [, facts] of storedFacts(root)) {
      expect(Object.keys(facts.tokens)).toEqual(["hashes"]);
    }
  });
});

test.each([
  ["truncated JSON", (original: string) => original.slice(0, original.length / 2)],
  ["empty file", () => ""],
  ["null", () => "null"],
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
