import type { DoctorRunOptions } from "../config.js";

export interface ParsedDoctorArgs {
  path: string;
  options: DoctorRunOptions;
}

export function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  const options: DoctorRunOptions = {};
  let path = ".";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--changed") options.changed = true;
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
    else if (arg === "--framework")
      options.framework = args[++index] as DoctorRunOptions["framework"];
    else if (arg === "--rules") options.rules = args[++index];
    else if (arg === "--severity") options.severity = args[++index] as DoctorRunOptions["severity"];
    else if (arg === "--extends") options.extends = parseExtends(args[++index]);
    else if (arg === "--since") options.since = args[++index];
    else if (arg === "--baseline") options.baseline = args[++index];
    else if (arg === "--format") options.format = args[++index];
    else if (!arg.startsWith("-")) path = arg;
  }
  return { options, path };
}

export function applyDoctorOptions(
  options: DoctorRunOptions,
  flags: Record<string, unknown>,
): void {
  if (flags.changed) options.changed = true;
  if (flags.types) options.types = true;
  if (flags.threads) options.threads = Number(flags.threads);
  options.coverage = stringFlag(flags.coverage) ?? options.coverage;
  options.runtimeEvidence = stringFlag(flags.runtimeEvidence) ?? options.runtimeEvidence;
  options.analyses = stringFlag(flags.analyses) ?? options.analyses;
  if (flags.emitGraph) options.emitGraph = true;
  options.confidenceMin = stringFlag(flags.confidenceMin) ?? options.confidenceMin;
  if (flags.structuralReview) options.structuralReview = true;
  if (flags.types === false) options.types = false;
  if (flags.profile) options.profile = true;
  if (flags.newOnly) options.newOnly = true;
  if (flags.updateBaseline) options.updateBaseline = true;
  if (flags.cache) options.cache = true;
  if (flags.cache === false) options.cache = false;
  if (flags.fix) options.fix = true;
  if (flags.unsafeFix) options.unsafeFix = true;
  if (flags.maxWarnings !== undefined) options.maxWarnings = Number(flags.maxWarnings);
  options.framework =
    (stringFlag(flags.framework) as DoctorRunOptions["framework"]) ?? options.framework;
  options.rules = stringFlag(flags.rules) ?? options.rules;
  options.severity =
    (stringFlag(flags.severity) as DoctorRunOptions["severity"]) ?? options.severity;
  options.extends = parseExtendsFlag(flags.extends) ?? options.extends;
  options.since = stringFlag(flags.since) ?? options.since;
  options.baseline = stringFlag(flags.baseline) ?? options.baseline;
  options.format = stringFlag(flags.format) ?? options.format;
}

function parseExtends(value: string | undefined): DoctorRunOptions["extends"] {
  if (!value || value === "auto") return "auto";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseExtendsFlag(value: unknown): DoctorRunOptions["extends"] | undefined {
  return typeof value === "string" ? parseExtends(value) : undefined;
}

export function stringFlag(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeDoctorCommand(args: string[], commands: Set<string>): string[] {
  const first = args.find((arg) => !arg.startsWith("-"));
  if (!first) return ["scan", ...args];
  if (commands.has(first)) return args;
  return ["scan", ...args];
}
