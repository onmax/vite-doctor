import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * `runViteDoctor` is not a public export, so the experiment reaches into the built chunk that
 * re-exports it under its real name. Production code must never do this.
 */
export async function loadDoctorApi(doctorRoot = repoRoot) {
  const dist = join(doctorRoot, "dist");
  const chunk = readdirSync(dist).find(
    (file) =>
      /^doctor-.*\.mjs$/.test(file) &&
      /export \{[^}]*\brunViteDoctor\s*[,}]/.test(readFileSync(join(dist, file), "utf8")),
  );
  if (!chunk) throw new Error(`No dist chunk exports runViteDoctor in ${dist}; run pnpm build.`);
  const [doctor, extension] = await Promise.all([
    import(pathToFileURL(join(dist, chunk)).href),
    import(pathToFileURL(join(dist, "extension.mjs")).href),
  ]);
  return { ...doctor, ...extension };
}
