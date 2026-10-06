import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor as runDoctor } from "../../src/doctor.ts";
import {
  flushStoreWrites,
  readCacheStatus,
  retainCacheStores,
} from "../../src/core/internal/cache-store.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("a retained store is written after the run and dropped once another writer replaces it", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-cache-retained-"));
  const cacheDir = join(root, ".vite-doctor/cache");
  const status = () => readCacheStatus(root, cacheDir);
  const options = { root, framework: "vite" as const, cache: true };
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "import { b } from './b'; export const a = b;\n");
    writeFileSync(join(root, "src/b.ts"), "export const b = 1;\n");
    retainCacheStores();

    const cold = await runDoctor(options);
    expect(status().exists).toBe(false);
    flushStoreWrites();
    expect(status().lastWrite).toMatchObject({ ruleResultsReused: 0 });
    expect(status().lastWrite!.ruleResultsComputed).toBeGreaterThan(0);

    await settle();
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
    const warm = await runDoctor(options);
    flushStoreWrites();
    expect(status().lastWrite!.ruleResultsReused).toBeGreaterThan(0);
    expect(warm.diagnostics).toEqual(cold.diagnostics);

    const replacement = join(cacheDir, "replacement");
    writeFileSync(replacement, "not a store");
    renameSync(replacement, join(cacheDir, "store.json"));
    await settle();
    writeFileSync(join(root, "src/b.ts"), "export const b = 3;\n");
    const afterReplace = await runDoctor(options);
    flushStoreWrites();
    expect(status().lastWrite).toMatchObject({ ruleResultsReused: 0 });
    expect(afterReplace.diagnostics).toEqual(cold.diagnostics);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
