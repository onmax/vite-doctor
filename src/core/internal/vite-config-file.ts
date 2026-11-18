import { existsSync } from "node:fs";
import { resolve } from "pathe";

// Vite's own lookup order for a config file without --config.
const VITE_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

export function findViteConfigFile(root: string): string | undefined {
  return VITE_CONFIG_FILES.map((name) => resolve(root, name)).find((file) => existsSync(file));
}
