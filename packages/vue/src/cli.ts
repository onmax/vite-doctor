#!/usr/bin/env node
import { resolve } from "pathe";
import {
  cleanCache,
  createReport,
  createRulesReport,
  defineDoctorPlugin,
  explainRule,
  runDoctor,
  vueRulePack,
  type DoctorRunOptions,
} from "@vue-doctor/core";

await main();

async function main() {
  const args = process.argv.slice(2);
  const command = isCommand(args[0]) ? args.shift()! : "scan";

  if (command === "rules") {
    const { options } = parseRunArgs(args);
    process.stdout.write(createRulesReport([vueRulePack], options.format));
    return;
  }

  if (command === "explain") {
    const ruleId = args.find((arg) => !arg.startsWith("-")) ?? "";
    const { options } = parseRunArgs(args.filter((arg) => arg !== ruleId));
    process.stdout.write(explainRule([vueRulePack], ruleId, options.format));
    return;
  }

  if (command === "cache" && args[0] === "clean") {
    cleanCache(process.cwd());
    console.log("Doctor cache cleaned");
    return;
  }

  if (
    command === "dead-code" ||
    command === "dupes" ||
    command === "health" ||
    command === "graph"
  ) {
    args.unshift("--analyses", command === "dupes" ? "dupes" : command);
  } else if (command === "benchmark" || command === "adopt") {
    args.unshift("--profile");
  } else if (command !== "scan" && command !== "check") {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
    return;
  }

  const { path, options } = parseRunArgs(args);
  const result = await runDoctor({
    ...options,
    root: resolve(process.cwd(), path),
    framework: "vue",
    plugins: [defineDoctorPlugin({ name: "vue-doctor/builtin-vue", rulePacks: [vueRulePack] })],
  });

  process.stdout.write(createReport(result, options.format));
  if (result.summary.blocker || result.summary.error) process.exitCode = 1;
  if (options.maxWarnings !== undefined && result.summary.warn > options.maxWarnings)
    process.exitCode = 1;
}

function isCommand(value: string | undefined): boolean {
  return (
    value === "scan" ||
    value === "check" ||
    value === "rules" ||
    value === "explain" ||
    value === "cache" ||
    value === "dead-code" ||
    value === "dupes" ||
    value === "health" ||
    value === "graph" ||
    value === "benchmark" ||
    value === "adopt"
  );
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
    else if (arg === "--coverage") options.coverage = args[++index];
    else if (arg === "--runtime-evidence") options.runtimeEvidence = args[++index];
    else if (arg === "--analyses") options.analyses = args[++index];
    else if (arg === "--emit-graph") options.emitGraph = true;
    else if (arg === "--confidence-min") options.confidenceMin = args[++index];
    else if (arg === "--structural-review") options.structuralReview = true;
    else if (arg === "--no-types") options.types = false;
    else if (arg === "--profile") options.profile = true;
    else if (arg === "--new-only") options.newOnly = true;
    else if (arg === "--update-baseline") options.updateBaseline = true;
    else if (arg === "--cache") options.cache = true;
    else if (arg === "--no-cache") options.cache = false;
    else if (arg === "--fix") options.fix = true;
    else if (arg === "--unsafe-fix") options.unsafeFix = true;
    else if (arg === "--max-warnings") options.maxWarnings = Number(args[++index]);
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
