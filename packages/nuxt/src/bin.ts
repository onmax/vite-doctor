#!/usr/bin/env node
import { main } from "./cli.js";

process.exitCode = await main();
