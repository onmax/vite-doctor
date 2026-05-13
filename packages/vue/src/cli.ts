#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { consola } from "consola";
import { resolve } from "pathe";
import { loadDoctorConfig } from "@vue-doctor/config";
import {
  cleanCache,
  createReport,
  createRulesReport,
  defineDoctorPlugin,
  explainRule,
  runDoctor,
  type DoctorRunOptions,
} from "@vue-doctor/core";
import { applyDoctorOptions, normalizeDoctorCommand } from "@vue-doctor/core/internal/cli";
import { vueRulePack } from "@vue-doctor/core/vue-rules";

const commands = new Set(["scan", "check", "rules", "explain", "cache"]);

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  let exitCode = 0;
  const cli = cac("vue-doctor");
  addScanCommand(cli, "scan", cwd, (code) => (exitCode = code));
  addScanCommand(cli, "check", cwd, (code) => (exitCode = code));
  cli
    .command("rules", "List Vue Doctor rules.")
    .option("--format <format>", "Output format.")
    .action((options) => {
      process.stdout.write(createRulesReport([vueRulePack], options.format));
    });
  cli
    .command("explain <rule>", "Explain a Vue Doctor rule.")
    .option("--format <format>", "Output format.")
    .action((rule: string, options) => {
      process.stdout.write(explainRule([vueRulePack], rule, options.format));
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
    cli.parse(["node", "vue-doctor", ...normalizeDoctorCommand(args, commands)], { run: false });
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
    .option("--config", "Load trusted doctor.config.*.")
    .option("--trusted-config", "Load trusted doctor.config.*.")
    .option("--changed", "Only scan changed files.")
    .option("--types", "Enable type-aware checks.")
    .option("--threads <threads>", "Thread count.")
    .option("--coverage <file>", "Coverage file.")
    .option("--runtime-evidence <file>", "Runtime evidence file.")
    .option("--analyses <analyses>", "Analyses to run.")
    .option("--emit-graph", "Emit graph.")
    .option("--confidence-min <confidence>", "Minimum confidence.")
    .option("--structural-review", "Enable structural review.")
    .option("--no-types", "Disable type-aware checks.")
    .option("--profile", "Include timings.")
    .option("--new-only", "Only report new diagnostics.")
    .option("--update-baseline", "Update baseline.")
    .option("--cache", "Use cache.")
    .option("--no-cache", "Disable cache.")
    .option("--fix", "Apply safe fixes.")
    .option("--unsafe-fix", "Apply unsafe fixes.")
    .option("--max-warnings <count>", "Maximum warnings.")
    .option("--rules <rules>", "Rule selector.")
    .option("--severity <severity>", "Minimum severity.")
    .option("--preset <preset>", "Rule preset.")
    .option("--since <ref>", "Git base ref.")
    .option("--baseline <file>", "Baseline file.")
    .option("--format <format>", "Output format.")
    .action(async (path = ".", options) => {
      const runOptions: DoctorRunOptions = {};
      applyDoctorOptions(runOptions, options);
      const root = resolve(cwd, path);
      if (options.config || options.trustedConfig) {
        runOptions.config = await loadDoctorConfig({ cwd: root });
      }
      const result = await runVueDoctor(root, runOptions);
      setExitCode(shouldFail(result, runOptions) ? 1 : 0);
    });
}

async function runVueDoctor(root: string, options: DoctorRunOptions) {
  const result = await runDoctor({
    ...options,
    framework: "vue",
    root,
    plugins: [defineDoctorPlugin({ name: "vue-doctor/builtin-vue", rulePacks: [vueRulePack] })],
  });

  process.stdout.write(createReport(result, options.format));
  return result;
}

function shouldFail(result: Awaited<ReturnType<typeof runDoctor>>, options: DoctorRunOptions) {
  return (
    result.summary.blocker > 0 ||
    result.summary.error > 0 ||
    (options.maxWarnings !== undefined && result.summary.warn > options.maxWarnings)
  );
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === currentFile) {
  process.exitCode = await main();
}
