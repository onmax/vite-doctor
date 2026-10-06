#!/usr/bin/env node
import module from "node:module";
import { main } from "./cli.js";

module.enableCompileCache();
process.exitCode = await main(process.argv.slice(2), process.cwd(), { hostExtensions: true });
