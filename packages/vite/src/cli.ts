#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planCi, type PlannedCommand } from "./index.js";

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const command = args.find((arg) => !arg.startsWith("-")) ?? "run";

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
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

Runs the project's existing scripts with the detected package manager.`);
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
