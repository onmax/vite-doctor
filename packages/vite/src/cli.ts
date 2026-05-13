#!/usr/bin/env node
import { statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "pathe";
import {
  cleanCache,
  createReport,
  createRulesReport,
  explainRule,
  type DoctorRunOptions,
} from "@vue-doctor/core";
import { planCi, type PlannedCommand } from "./index.js";
import { runViteDoctor, shouldFailDoctorRun, viteDoctorRulePacks } from "./doctor.js";

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const firstPositional = args.find((arg) => !arg.startsWith("-"));
  const command = firstPositional ? (isCommand(firstPositional) ? firstPositional : "scan") : "run";

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }

  if (command === "rules") {
    const { options } = parseRunArgs(args.filter((arg) => arg !== command));
    process.stdout.write(createRulesReport(viteDoctorRulePacks(), options.format));
    return 0;
  }

  if (command === "explain") {
    const rest = args.filter((arg) => arg !== command);
    const ruleId = rest.find((arg) => !arg.startsWith("-")) ?? "";
    const { options } = parseRunArgs(rest.filter((arg) => arg !== ruleId));
    process.stdout.write(explainRule(viteDoctorRulePacks(), ruleId, options.format));
    return 0;
  }

  if (command === "cache" && args.includes("clean")) {
    cleanCache(cwd);
    console.log("Doctor cache cleaned");
    return 0;
  }

  if (command === "scan" || command === "check") {
    const { path, options } = parseRunArgs(args.filter((arg) => arg !== command));
    const root = resolve(cwd, path);
    const stat = statSync(root, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      console.error(`No readable directory found at ${root}`);
      return 1;
    }
    const result = await runViteDoctor({
      ...options,
      root,
    });
    process.stdout.write(createReport(result, options.format));
    return shouldFailDoctorRun(result, options.maxWarnings) ? 1 : 0;
  }

  if (command !== "run" && command !== "ci") {
    console.error(`Unknown command: ${command}`);
    return 1;
  }

  let plan;
  try {
    plan = planCi(cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`Package manager: ${plan.packageManager}`);
  console.log("Commands:");
  for (const item of plan.commands) console.log(`- ${item.display}`);

  if (dryRun) return 0;

  for (const item of plan.commands) {
    const exitCode = await runCommand(item, cwd);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

function printHelp() {
  console.log(`vite-doctor

Usage:
  vite-doctor [run] [--dry-run]
  vite-doctor [path]
  vite-doctor scan [path]
  vite-doctor check [path]
  vite-doctor rules [--format json]

Runs the project's existing scripts with the detected package manager by default.`);
}

function parseRunArgs(args: string[]): { path: string; options: DoctorRunOptions } {
  const options: DoctorRunOptions = {};
  let path = ".";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--trusted-config" || arg === "--config") options.config = true;
    else if (arg === "--changed") options.changed = true;
    else if (arg === "--types") options.types = true;
    else if (arg === "--threads") options.threads = Number(args[++index]);
    else if (arg === "--analyses") options.analyses = args[++index];
    else if (arg === "--profile") options.profile = true;
    else if (arg === "--new-only") options.newOnly = true;
    else if (arg === "--cache") options.cache = true;
    else if (arg === "--no-cache") options.cache = false;
    else if (arg === "--fix") options.fix = true;
    else if (arg === "--unsafe-fix") options.unsafeFix = true;
    else if (arg === "--max-warnings") options.maxWarnings = Number(args[++index]);
    else if (arg === "--framework")
      options.framework = args[++index] as DoctorRunOptions["framework"];
    else if (arg === "--rules") options.rules = args[++index];
    else if (arg === "--severity") options.severity = args[++index] as DoctorRunOptions["severity"];
    else if (arg === "--preset") options.preset = args[++index];
    else if (arg === "--since") options.since = args[++index];
    else if (arg === "--baseline") options.baseline = args[++index];
    else if (arg === "--format") options.format = args[++index];
    else if (!arg.startsWith("-")) path = arg;
  }
  return { path, options };
}

function isCommand(value: string) {
  return ["run", "ci", "rules", "explain", "cache", "scan", "check"].includes(value);
}

function runCommand(item: PlannedCommand, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(item.command, item.args, { cwd, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`Failed to run ${item.display}: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        console.error(`${item.display} exited from signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  process.exitCode = await main();
}
