#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./cli-main.js";

export { main };

const currentFile = fileURLToPath(import.meta.url);
let invokedFile: string | undefined;
try {
  if (process.argv[1]) invokedFile = realpathSync(process.argv[1]);
} catch {
  invokedFile = undefined;
}
if (invokedFile === currentFile) {
  process.exitCode = await main();
}
