import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { loadNuxt } from "nuxt/kit";
import { expect, test } from "vite-plus/test";
import nuxtDoctorModule, { writeManifest } from "../../../src/rule-packs/nuxt/module.ts";

type Fixture = {
  root: string;
  nuxt: Awaited<ReturnType<typeof loadNuxt>>;
  reads: () => number;
  failNextRead: () => void;
};

async function withNuxtFixture(run: (fixture: Fixture) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-composable-reuse-"));
  const composable = join(root, "layer/app/composables/useLayer.ts");
  const fsPromises = createRequire(import.meta.url)("node:fs/promises");
  const readFile = fsPromises.readFile;
  let reads = 0;
  let failNext = false;
  fsPromises.readFile = function (this: unknown, path: unknown, ...rest: unknown[]) {
    if (String(path) === composable) {
      reads++;
      if (failNext) {
        failNext = false;
        return Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
      }
    }
    return Reflect.apply(readFile, this, [path, ...rest]);
  };
  syncBuiltinESMExports();
  let nuxt: Fixture["nuxt"] | undefined;
  const cwd = process.cwd();
  try {
    symlinkSync(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      join(root, "node_modules"),
      "junction",
    );
    for (const [file, source] of Object.entries({
      "package.json": JSON.stringify({ type: "module" }),
      "nuxt.config.ts": "export default { extends: ['./layer'] }",
      "app/composables/useApp.ts": "export function useApp() {}",
      "layer/nuxt.config.ts": "export default {}",
      "layer/app/composables/useLayer.ts": "export function useLayer() {}",
    })) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    process.chdir(root);
    nuxt = await loadNuxt({
      cwd: root,
      overrides: { modules: [nuxtDoctorModule], telemetry: false },
    });
    await run({
      root,
      nuxt,
      reads: () => reads,
      failNextRead: () => {
        failNext = true;
      },
    });
    await nuxt.close();
    nuxt = undefined;
  } finally {
    fsPromises.readFile = readFile;
    syncBuiltinESMExports();
    await nuxt?.close();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

test("scans composables once per Nuxt import regeneration across manifest writes", async () => {
  await withNuxtFixture(async ({ root, nuxt, reads }) => {
    const readsAfterLoad = reads();
    expect(readsAfterLoad).toBeGreaterThan(0);
    await nuxt.callHook("builder:generateApp");
    await nuxt.callHook("builder:generateApp");
    expect(reads()).toBe(readsAfterLoad);

    writeFileSync(join(root, "app/composables/useAdded.ts"), "export function useAdded() {}");
    await nuxt.callHook("builder:watch", "add", join(root, "app/composables/useAdded.ts"));
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.scannedComposableFiles).toEqual([
      "app/composables/useAdded.ts",
      "app/composables/useApp.ts",
      "layer/app/composables/useLayer.ts",
    ]);
  });
}, 30000);

test("rescans composables on the next manifest write after a failed scan", async () => {
  await withNuxtFixture(async ({ root, nuxt, failNextRead }) => {
    const evidence = {
      autoImportContext: { getImports: () => [] },
      importDirs: [join(root, "app/composables"), join(root, "layer/app/composables")],
    };
    failNextRead();
    await expect(writeManifest(nuxt, evidence)).rejects.toThrow("EIO");
    const manifest = await writeManifest(nuxt, evidence);
    expect(manifest.scannedComposableFiles).toEqual([
      "app/composables/useApp.ts",
      "layer/app/composables/useLayer.ts",
    ]);
  });
}, 30000);
