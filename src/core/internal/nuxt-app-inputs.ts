import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import ignore from "ignore";
import { relative, resolve } from "pathe";
import { globSync } from "tinyglobby";
import type { NuxtDoctorManifest } from "../primitives.js";

type AppInputs = NonNullable<NonNullable<NuxtDoctorManifest["resolvedApp"]>["inputs"]>;

export function nuxtAppInputSignature(root: string, inputs: Omit<AppInputs, "signature">) {
  const entries = new Map<string, string>();
  function record(path: string) {
    try {
      const stat = statSync(path);
      if (stat.isFile()) {
        entries.set(path, `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const ignored = ignore(inputs.ignore.options).add(inputs.ignore.patterns);
    const layerRoots = inputs.ignore.roots
      .map((dir) => resolve(root, dir))
      .sort((left, right) => right.length - left.length);
    for (const { directory, patterns } of inputs.directories) {
      const cwd = resolve(root, directory);
      for (const path of globSync(patterns, { cwd, absolute: true, followSymbolicLinks: true })) {
        const layer = layerRoots.find((dir) =>
          path.startsWith(dir.endsWith("/") ? dir : `${dir}/`),
        );
        const name = relative(layer ?? root, path);
        if ((!layer && name.startsWith("..")) || !ignored.ignores(name)) record(path);
      }
    }
    for (const file of inputs.files) record(resolve(root, file));
    const ordered = [...entries].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
  } catch {
    return undefined;
  }
}
