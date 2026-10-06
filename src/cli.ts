#!/usr/bin/env node
import module from "node:module";
import { basename } from "node:path";
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

if (["cli.mjs", "cli.ts"].includes(basename(process.argv[1] ?? ""))) {
  // Must run before cli-main is imported so the Doctor graph and its parsers hit the cache.
  // Node skips it when NODE_DISABLE_COMPILE_CACHE is set.
  module.enableCompileCache();
  process.exitCode = await main();
}
