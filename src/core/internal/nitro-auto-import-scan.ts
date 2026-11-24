import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { normalize } from "pathe";

export function nitroAutoImportScanFingerprint(patterns: string[]): string | undefined {
  try {
    const files = globSync(
      patterns.filter((pattern) => !pattern.startsWith("!")),
      {
        exclude: patterns
          .filter((pattern) => pattern.startsWith("!"))
          .map((pattern) => pattern.slice(1)),
      },
    );
    const hash = createHash("sha256");
    for (const file of [...new Set(files.map(normalize))].sort()) {
      if (!statSync(file).isFile()) continue;
      hash.update(
        JSON.stringify([file, createHash("sha256").update(readFileSync(file)).digest("hex")]),
      );
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}
