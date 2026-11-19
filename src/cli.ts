#!/usr/bin/env node
import { realpathSync } from "node:fs";
import module from "node:module";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli-run.js";

export { main } from "./cli-run.js";

// The `vite-doctor` bin starts from bin.ts. This guard only keeps `node dist/cli.mjs` working;
// importing `vite-doctor/cli` must not start a Doctor Run.
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  // Must run before cli-main is imported so the Doctor graph and its parsers hit the cache.
  // Node skips it when NODE_DISABLE_COMPILE_CACHE is set.
  module.enableCompileCache();
  process.exitCode = await runCli();
}
