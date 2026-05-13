#!/usr/bin/env node
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { consola } from "consola";
import { resolve } from "pathe";
import {
  cleanCache,
  createReport,
  createRulesReport,
  explainRule,
  type DoctorRunOptions,
} from "@vue-doctor/core";
import {
  applyDoctorOptions,
  normalizeDoctorCommand,
  parseDoctorArgs,
} from "@vue-doctor/core/internal/cli";
import { runViteDoctor, shouldFailDoctorRun, viteDoctorRulePacks } from "./doctor.js";

const commands = new Set(["scan", "check", "rules", "explain", "cache"]);
const removedCommands = new Set(["run", "ci"]);

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  if (removedCommands.has(args[0] ?? "")) {
    errorHuman(`vite-doctor ${args[0]} was removed. Use your package manager scripts directly.`);
    return 1;
  }

  let exitCode = 0;
  const cli = cac("vite-doctor");
  addScanCommand(cli, "scan", cwd, (code) => (exitCode = code));
  addScanCommand(cli, "check", cwd, (code) => (exitCode = code));
  cli
    .command("rules", "List available Doctor rules.")
    .option("--format <format>", "Output format.")
    .option("--framework <framework>", "Framework override.")
    .action(async (options) => {
      const runOptions: DoctorRunOptions = {};
      applyDoctorOptions(runOptions, options);
      process.stdout.write(
        createRulesReport(await viteDoctorRulePacks(runOptions), runOptions.format),
      );
    });
  cli
    .command("explain <rule>", "Explain a Doctor rule.")
    .option("--format <format>", "Output format.")
    .option("--framework <framework>", "Framework override.")
    .action(async (rule: string, options) => {
      const runOptions: DoctorRunOptions = {};
      applyDoctorOptions(runOptions, options);
      process.stdout.write(
        explainRule(await viteDoctorRulePacks(runOptions), rule, runOptions.format),
      );
    });
  cli.command("cache <action>", "Manage Doctor cache.").action((action: string) => {
    if (action === "clean") {
      cleanCache(cwd);
      consola.log("Doctor cache cleaned");
      return;
    }
    consola.error(`Unknown cache command: ${action}`);
    exitCode = 1;
  });
  cli.help();

  try {
    cli.parse(["node", "vite-doctor", ...normalizeDoctorCommand(args, commands)], { run: false });
    const result = await cli.runMatchedCommand();
    if (typeof result === "number") exitCode = result;
    return exitCode;
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function addScanCommand(
  cli: ReturnType<typeof cac>,
  name: "scan" | "check",
  cwd: string,
  setExitCode: (code: number) => void,
) {
  cli
    .command(`${name} [path]`, `Run ${name} diagnostics.`)
    .option("--changed", "Only scan changed files.")
    .option("--types", "Enable type-aware checks.")
    .option("--threads <threads>", "Thread count.")
    .option("--analyses <analyses>", "Analyses to run.")
    .option("--profile", "Include timings.")
    .option("--new-only", "Only report new diagnostics.")
    .option("--cache", "Use cache.")
    .option("--no-cache", "Disable cache.")
    .option("--fix", "Apply safe fixes.")
    .option("--unsafe-fix", "Apply unsafe fixes.")
    .option("--max-warnings <count>", "Maximum warnings.")
    .option("--framework <framework>", "Framework override.")
    .option("--rules <rules>", "Rule selector.")
    .option("--severity <severity>", "Minimum severity.")
    .option("--preset <preset>", "Rule preset.")
    .option("--since <ref>", "Git base ref.")
    .option("--baseline <file>", "Baseline file.")
    .option("--format <format>", "Output format.")
    .option("--config", "Unsupported in vite-doctor.")
    .option("--trusted-config", "Unsupported in vite-doctor.")
    .action(async (path = ".", options) => {
      const parsed = parseDoctorArgs([path]);
      applyDoctorOptions(parsed.options, options);
      if (options.config || options.trustedConfig) {
        errorHuman(
          "Executable config loading was removed from vite-doctor. Use vue-doctor, nuxt-doctor, or @vue-doctor/config for trusted config files.",
        );
        setExitCode(1);
        return;
      }
      setExitCode(await runScan(parsed.path, parsed.options, cwd));
    });
}

async function runScan(path: string, options: DoctorRunOptions, cwd: string): Promise<number> {
  const root = resolve(cwd, path);
  const stat = statSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    errorHuman(`No readable directory found at ${root}`);
    return 1;
  }
  const result = await runViteDoctor({ ...options, root });
  process.stdout.write(createReport(result, options.format));
  return shouldFailDoctorRun(result, options.maxWarnings) ? 1 : 0;
}

function errorHuman(message: string) {
  consola.error(message);
  if (process.env.VITEST_WORKER_ID) console.error(message);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === currentFile) {
  process.exitCode = await main();
}
