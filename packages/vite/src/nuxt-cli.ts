#!/usr/bin/env node
import { main } from "nuxt-doctor/cli";

const code = await main();
if (code !== 0) {
  process.exitCode = code;
  throw new Error(`Nuxt Doctor failed with exit code ${code}`);
}
