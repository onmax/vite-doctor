#!/usr/bin/env node
import module from "node:module";
import { runCli } from "./cli-run.js";

// Must run before cli-main is imported so the Doctor graph and its parsers hit the cache.
// Node skips it when NODE_DISABLE_COMPILE_CACHE is set.
module.enableCompileCache();
process.exitCode = await runCli();
