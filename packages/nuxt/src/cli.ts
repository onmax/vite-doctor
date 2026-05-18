import { cac } from "cac";
import { consola } from "consola";
import { resolve } from "pathe";
import {
  cleanCache,
  createReport,
  createRulesReport,
  explainRule,
  runDoctor,
  type DoctorRunOptions,
  type RulePack,
} from "@vue-doctor/core";
import {
  applyDoctorOptions,
  normalizeDoctorCommand,
  parseDoctorArgs,
} from "@vue-doctor/core/internal/cli";
import { loadDoctorConfig } from "../../core/src/config.js";
import { nuxtDoctorExtensions, nuxtRulePacks } from "./rules/index.js";

const commands = new Set(["scan", "check", "rules", "explain", "cache"]);

export interface RunNuxtDoctorOptions extends DoctorRunOptions {
  cwd?: string;
  extraRulePacks?: RulePack[];
}

export async function runNuxtDoctor(options: RunNuxtDoctorOptions = {}) {
  const { cwd, extraRulePacks, ...runOptions } = options;
  const result = await runDoctor({
    ...runOptions,
    framework: "nuxt",
    extensions: [...nuxtDoctorExtensions(extraRulePacks), ...(runOptions.extensions ?? [])],
    root: resolve(cwd ?? process.cwd(), runOptions.root ?? "."),
  });
  process.stdout.write(createReport(result, runOptions.format));
  return result;
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  let exitCode = 0;
  const cli = cac("nuxt-doctor");
  addScanCommand(cli, "scan", cwd, (code) => (exitCode = code));
  addScanCommand(cli, "check", cwd, (code) => (exitCode = code));
  cli
    .command("rules", "List Nuxt Doctor rules.")
    .option("--format <format>", "Machine output: json or sarif.")
    .action((options) => {
      process.stdout.write(createRulesReport(nuxtRulePacks(), options.format));
    });
  cli
    .command("explain <rule>", "Explain a Nuxt Doctor rule.")
    .option("--format <format>", "Machine output: json or sarif.")
    .action((rule: string, options) => {
      process.stdout.write(explainRule(nuxtRulePacks(), rule, options.format));
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
    cli.parse(["node", "nuxt-doctor", ...normalizeDoctorCommand(args, commands)], { run: false });
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
    .option("--extends <extends>", "Comma-separated rule-pack presets.")
    .option("--since <ref>", "Git base ref.")
    .option("--baseline <file>", "Baseline file.")
    .option("--format <format>", "Machine output: json or sarif.")
    .action(async (path = ".", options) => {
      const runOptions: DoctorRunOptions = {};
      applyDoctorOptions(runOptions, options);
      const root = resolve(cwd, path);
      if (options.config || options.trustedConfig) {
        runOptions.config = await loadDoctorConfig({ cwd: root });
      }
      const result = await runNuxtDoctor({ ...runOptions, cwd, root: path });
      setExitCode(shouldFail(result, runOptions) ? 1 : 0);
    });
}

export function parseRunArgs(args: string[]): { path: string; options: DoctorRunOptions } {
  return parseDoctorArgs(args);
}

function shouldFail(result: Awaited<ReturnType<typeof runDoctor>>, options: DoctorRunOptions) {
  return (
    result.summary.blocker > 0 ||
    result.summary.error > 0 ||
    (options.maxWarnings !== undefined && result.summary.warn > options.maxWarnings)
  );
}
