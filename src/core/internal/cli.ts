import type { DoctorRunOptions } from "../config.js";

export function applyDoctorOptions(
  options: DoctorRunOptions,
  flags: Record<string, unknown>,
): void {
  if (flags.changed) options.changed = true;
  options.analyses = stringFlag(flags.analyses) ?? options.analyses;
  if (flags.structuralReview) options.structuralReview = true;
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
  options.format = (stringFlag(flags.format) as DoctorRunOptions["format"]) ?? options.format;
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
