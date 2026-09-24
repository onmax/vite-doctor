import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { runViteDoctor } from "../../../src/doctor.js";
import type { DoctorRunOptions } from "../../../src/core/config.js";

export async function withPackage<T>(
  manifest: object,
  files: Record<string, string>,
  run: (root: string) => Promise<T>,
) {
  const root = mkdtempSync(join(tmpdir(), "doctor-package-"));
  try {
    for (const [file, text] of Object.entries({
      "package.json": JSON.stringify({ name: "example-library", ...manifest }),
      ...files,
    })) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function diagnose(
  manifest: object,
  files: Record<string, string>,
  options: DoctorRunOptions = {},
) {
  return withPackage(manifest, files, async (root) => {
    const result = await runViteDoctor({
      root,
      framework: "vite",
      cache: false,
      extends: ["package/recommended"],
      ...options,
    });
    return result.diagnostics.filter((diagnostic) => diagnostic.ruleId.startsWith("package/"));
  });
}
