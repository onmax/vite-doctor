import { parseSync } from "oxc-parser";
import { resolve } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import {
  configFiles,
  literalValue,
  propertyKey,
  runtimeMajor,
  unwrapConfig,
  viteNitroOptionObjects,
} from "./server-layout.js";

export interface NitroConfigSource {
  /** Absolute path of the config file. */
  file: string;
  /** The Nitro options object, or `null` when Doctor cannot read it statically. */
  nitro: any | null;
  /** The whole nuxt.config object for Nuxt projects. */
  nuxt?: any | null;
}

const NITRO_CONFIG_FILES = configFiles("nitro.config");
const VITE_CONFIG_FILES = configFiles("vite.config");
const NUXT_CONFIG_FILES = configFiles("nuxt.config");

/**
 * The Nitro options each config file of the project declares: nitro.config, the nitro() Vite
 * plugin, or the `nitro` key of nuxt.config. Files that do not exist are left out.
 */
export function nitroConfigSources(ctx: RuleContext): NitroConfigSource[] {
  const key = "nitro:config-sources";
  let sources = ctx.cache.get<NitroConfigSource[]>(key);
  if (sources) return sources;
  const root = ctx.project.root;
  sources = [];
  if (ctx.project.framework === "nuxt") {
    for (const name of NUXT_CONFIG_FILES) {
      const file = resolve(root, name);
      const program = parseConfig(ctx, file);
      if (program === undefined) continue;
      const nuxt = program && unwrapConfig(defaultExport(program));
      if (!nuxt) {
        sources.push({ file, nitro: null, nuxt: null });
        continue;
      }
      const property = findProperty(nuxt, "nitro");
      const nitro =
        property === undefined
          ? { type: "ObjectExpression", properties: [] }
          : (unwrapConfig(property) ?? null);
      sources.push({ file, nitro, nuxt });
    }
  } else {
    for (const name of NITRO_CONFIG_FILES) {
      const file = resolve(root, name);
      const program = parseConfig(ctx, file);
      if (program === undefined) continue;
      sources.push({ file, nitro: (program && unwrapConfig(defaultExport(program))) ?? null });
    }
    for (const name of VITE_CONFIG_FILES) {
      const file = resolve(root, name);
      const program = parseConfig(ctx, file);
      if (program === undefined) continue;
      if (program === null) {
        sources.push({ file, nitro: null });
        continue;
      }
      for (const nitro of viteNitroOptionObjects(program) ?? []) sources.push({ file, nitro });
    }
  }
  ctx.cache.set(key, sources);
  return sources;
}

/** The value of a non-computed property, or undefined when the object does not declare it. */
export function findProperty(object: any, name: string): any {
  return object?.properties?.findLast(
    (property: any) =>
      property.type === "Property" && !property.computed && propertyKey(property.key) === name,
  )?.value;
}

/** Whether the object can hold keys Doctor cannot name: spreads or computed keys. */
export function hasOpaqueKeys(object: any): boolean {
  return object.properties.some(
    (property: any) =>
      property.type !== "Property" || property.computed || !propertyKey(property.key),
  );
}

/**
 * Keys that start with `$`, such as `$production` or `$env`, which c12 merges over the config for
 * one environment.
 */
export function hasEnvironmentOverrides(object: any): boolean {
  return object.properties.some(
    (property: any) => property.type === "Property" && propertyKey(property.key)?.startsWith("$"),
  );
}

/**
 * The Nitro major version that builds the project: Nitro's own, or for Nuxt the one its major
 * ships with (Nuxt 3 and 4 run nitropack 2, Nuxt 5 runs Nitro 3).
 */
export function nitroMajor(ctx: RuleContext): number | undefined {
  const nitro = runtimeMajor(ctx.project, "nitro");
  if (nitro !== undefined) return nitro;
  if (ctx.project.framework !== "nuxt") return undefined;
  const nuxt = runtimeMajor(ctx.project, "nuxt");
  return nuxt === undefined ? undefined : nuxt >= 5 ? 3 : 2;
}

const PRESET_ENV = /\b(?:NITRO_PRESET|SERVER_PRESET)=["']?([\w-]+)/g;

/**
 * The deployment preset a production build uses, kebab-cased as Nitro resolves it. Undefined
 * when the config does not name one statically, names it per environment, or a package script
 * sets a different one through NITRO_PRESET or SERVER_PRESET.
 */
export function nitroDeployPreset(ctx: RuleContext): string | undefined {
  const key = "nitro:deploy-preset";
  const cached = ctx.cache.get<{ preset?: string }>(key);
  if (cached) return cached.preset;
  const preset = resolveDeployPreset(ctx);
  ctx.cache.set(key, { preset });
  return preset;
}

function resolveDeployPreset(ctx: RuleContext): string | undefined {
  const presets = new Set<string>();
  for (const source of nitroConfigSources(ctx)) {
    if (!source.nitro || source.nuxt === null) return undefined;
    if (source.nuxt && hasEnvironmentOverrides(source.nuxt)) return undefined;
    if (hasOpaqueKeys(source.nitro) || hasEnvironmentOverrides(source.nitro)) return undefined;
    const value = findProperty(source.nitro, "preset");
    if (value === undefined) continue;
    const preset = literalValue(value);
    if (typeof preset !== "string") return undefined;
    presets.add(kebabPreset(preset));
  }
  const manifest = ctx.fs.readJson(resolve(ctx.project.root, "package.json")) as {
    scripts?: Record<string, unknown>;
  } | null;
  for (const script of Object.values(manifest?.scripts ?? {})) {
    if (typeof script !== "string") continue;
    for (const match of script.matchAll(PRESET_ENV)) presets.add(kebabPreset(match[1]!));
  }
  return presets.size === 1 ? [...presets][0] : undefined;
}

function kebabPreset(name: string) {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

/** The program, `null` when the file does not parse, or undefined when it does not exist. */
function parseConfig(ctx: RuleContext, file: string): any {
  const text = ctx.fs.readText(file);
  if (text === undefined) return undefined;
  try {
    const parsed = parseSync(file, text, { sourceType: "module", lang: "ts" });
    return parsed.errors.length ? null : parsed.program;
  } catch {
    return null;
  }
}

function defaultExport(program: any) {
  return program.body.find((statement: any) => statement.type === "ExportDefaultDeclaration")
    ?.declaration;
}
