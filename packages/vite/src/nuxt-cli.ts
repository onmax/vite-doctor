#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "nuxt-doctor/cli";

export { main };

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === currentFile) {
  const code = await main();
  if (code !== 0) {
    process.exitCode = code;
    throw new Error(`Nuxt Doctor failed with exit code ${code}`);
  }
}
