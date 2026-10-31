import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { loadNuxt } from "nuxt/kit";
import { expect, test } from "vite-plus/test";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";

test("scans composables once per Nuxt import regeneration across manifest writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-composable-reuse-"));
  const composable = join(root, "layer/app/composables/useLayer.ts");
  const fsPromises = createRequire(import.meta.url)("node:fs/promises");
  const readFile = fsPromises.readFile;
  let reads = 0;
  fsPromises.readFile = function (this: unknown, path: unknown, ...rest: unknown[]) {
    if (String(path) === composable) reads++;
    return Reflect.apply(readFile, this, [path, ...rest]);
  };
  syncBuiltinESMExports();
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined;
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
    const readsAfterLoad = reads;
    await nuxt.callHook("builder:generateApp");
    await nuxt.callHook("builder:generateApp");
    expect(reads).toBe(readsAfterLoad);

    writeFileSync(join(root, "app/composables/useAdded.ts"), "export function useAdded() {}");
    await nuxt.callHook("builder:watch", "add", join(root, "app/composables/useAdded.ts"));
    await nuxt.close();
    nuxt = undefined;
    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.scannedComposableFiles).toEqual([
      "app/composables/useAdded.ts",
      "app/composables/useApp.ts",
      "layer/app/composables/useLayer.ts",
    ]);
  } finally {
    fsPromises.readFile = readFile;
    syncBuiltinESMExports();
    await nuxt?.close();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
