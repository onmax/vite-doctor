#!/usr/bin/env node
import { realpathSync } from "node:fs";
import module from "node:module";
import { fileURLToPath } from "node:url";
import type { CliSurfaceOptions } from "./cli-main.js";
import { viteDoctorVersion } from "./version.js";

export async function main(
  args = process.argv.slice(2),
  cwd = process.cwd(),
  surface: CliSurfaceOptions = {},
): Promise<number> {
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${viteDoctorVersion}\n`);
    return 0;
  }
  const cli = await import("./cli-main.js");
  return cli.main(args, cwd, surface);
}

const currentFile = fileURLToPath(import.meta.url);
let invokedFile: string | undefined;
try {
  if (process.argv[1]) invokedFile = realpathSync(process.argv[1]);
} catch {
  invokedFile = undefined;
}
if (invokedFile === currentFile) {
  // Must run before cli-main is imported so the Doctor graph and its parsers hit the cache.
  // Node skips it when NODE_DISABLE_COMPILE_CACHE is set.
  module.enableCompileCache();
  process.exitCode = await main();
}
