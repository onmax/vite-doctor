import { isString } from "./value-schema.js";
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
  options.framework = frameworkFlag(flags.framework) ?? options.framework;
  options.rules = stringFlag(flags.rules) ?? options.rules;
  options.severity = severityFlag(flags.severity) ?? options.severity;
  options.extends = parseExtendsFlag(flags.extends) ?? options.extends;
  options.since = stringFlag(flags.since) ?? options.since;
  options.baseline = stringFlag(flags.baseline) ?? options.baseline;
  options.format = formatFlag(flags.format) ?? options.format;
}

function frameworkFlag(value: unknown): DoctorRunOptions["framework"] {
  if (!isString(value)) return undefined;
  switch (value) {
    case "auto":
    case "vue":
    case "vite":
    case "nitro":
    case "nuxt":
      return value;
    default:
      throw new Error(`Unknown framework ${JSON.stringify(value)}.`);
  }
}

function severityFlag(value: unknown): DoctorRunOptions["severity"] {
  if (!isString(value)) return undefined;
  if (value === "error" || value === "warn" || value === "info") return value;
  throw new Error(`Unknown severity ${JSON.stringify(value)}.`);
}

function formatFlag(value: unknown): DoctorRunOptions["format"] {
  return value === "text" || value === "json" || value === "sarif" || value === "agent"
    ? value
    : undefined;
}

function parseExtends(value: string | undefined): DoctorRunOptions["extends"] {
  if (!value || value === "auto") return "auto";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseExtendsFlag(value: unknown): DoctorRunOptions["extends"] | undefined {
  return isString(value) ? parseExtends(value) : undefined;
}

export function stringFlag(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}
