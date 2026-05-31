#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./cli-main.js";

export { main };

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === currentFile) {
  process.exitCode = await main();
}
