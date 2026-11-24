import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "pathe";

export function nuxtAppInputSignature(root: string, directories: string[], files: string[]) {
  const entries = new Map<string, string>();
  function scan(path: string, recursive: boolean, ancestors = new Set<string>()) {
    try {
      const stat = statSync(path);
      if (stat.isFile()) {
        entries.set(path, `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
      } else if (recursive && stat.isDirectory()) {
        const target = realpathSync(path);
        if (ancestors.has(target)) return;
        ancestors.add(target);
        for (const child of readdirSync(path)) scan(join(path, child), true, ancestors);
        ancestors.delete(target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    for (const directory of directories) scan(resolve(root, directory), true);
    for (const file of files) scan(resolve(root, file), false);
    const ordered = [...entries].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
  } catch {
    return undefined;
  }
}
