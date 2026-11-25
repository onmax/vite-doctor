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
  const strict = Array.isArray(flags.strict) ? flags.strict.at(-1) : flags.strict;
  options.extends =
    withStrictFlag(parseExtendsFlag(flags.extends), strict === true) ?? options.extends;
  options.since = stringFlag(flags.since) ?? options.since;
  options.baseline = stringFlag(flags.baseline) ?? options.baseline;
  options.format = (stringFlag(flags.format) as DoctorRunOptions["format"]) ?? options.format;
  options.mcp = parseMcpFlags(flags.mcpUrl, flags.mcpHeader) ?? options.mcp;
}

/** `--mcp-url` and `--mcp-header` are repeatable; every header applies to every URL. */
function parseMcpFlags(urls: unknown, headers: unknown): DoctorRunOptions["mcp"] {
  const urlList = listFlag(urls, "--mcp-url");
  const headerList = listFlag(headers, "--mcp-header");
  if (!urlList.length) {
    if (headerList.length) throw new Error("--mcp-header requires --mcp-url <url>.");
    return undefined;
  }
  const parsed: Record<string, string> = {};
  for (const header of headerList) {
    const colon = header.indexOf(":");
    const name = colon === -1 ? "" : header.slice(0, colon).trim();
    if (!name)
      throw new Error(
        `--mcp-header ${JSON.stringify(header)} must look like "Name: value", such as "Authorization: Bearer <token>".`,
      );
    parsed[name] = header.slice(colon + 1).trim();
  }
  return urlList.map((url) => ({
    url,
    ...(headerList.length ? { headers: { ...parsed } } : {}),
  }));
}

function listFlag(value: unknown, flag: string): string[] {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (typeof item !== "string" || !item) throw new Error(`${flag} requires a value.`);
    return item;
  });
}

function parseExtends(value: string | undefined): DoctorRunOptions["extends"] {
  if (!value || value === "auto") return "auto";
  if (value === "strict") return "strict";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseExtendsFlag(value: unknown): DoctorRunOptions["extends"] | undefined {
  return typeof value === "string" ? parseExtends(value) : undefined;
}

// `--strict` is `--extends strict`; next to `--extends` it adds "strict" to the listed presets.
function withStrictFlag(
  value: DoctorRunOptions["extends"],
  strict: boolean,
): DoctorRunOptions["extends"] {
  if (!strict) return value;
  if (value === undefined || value === "strict") return "strict";
  if (value === "auto") return ["auto", "strict"];
  return value.includes("strict") ? value : [...value, "strict"];
}

export function stringFlag(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
