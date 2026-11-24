import { parseSync } from "oxc-parser";
import { isAbsolute, relative, resolve } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import {
  configFiles,
  literalValue,
  nitroServerDirs,
  propertyKey,
  runtimeMajor,
  unwrapConfig,
  viteNitroOptionObjects,
} from "./server-layout.js";

export interface NitroConfigSource {
  /** Absolute path of the config file. */
  file: string;
  /** The Nitro options object, or `null` when Doctor cannot read it statically. */
  nitro: any;
  /** The whole nuxt.config object for Nuxt projects. */
  nuxt?: any;
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
  }
  for (const name of NITRO_CONFIG_FILES) {
    const file = resolve(root, name);
    const program = parseConfig(ctx, file);
    if (program === undefined) continue;
    sources.push({ file, nitro: (program && unwrapConfig(defaultExport(program))) ?? null });
  }
  for (const name of ctx.project.framework === "nuxt" ? [] : VITE_CONFIG_FILES) {
    const file = resolve(root, name);
    const program = parseConfig(ctx, file);
    if (program === undefined) continue;
    if (program === null) {
      sources.push({ file, nitro: null });
      continue;
    }
    for (const nitro of viteNitroOptionObjects(program) ?? []) sources.push({ file, nitro });
  }
  for (const name of [".nitrorc", ...(ctx.project.framework === "nuxt" ? [".nuxtrc"] : [])]) {
    const file = resolve(root, name);
    if (ctx.fs.exists(file)) sources.push({ file, nitro: null });
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
      property.type !== "Property" || property.computed || propertyKey(property.key) === null,
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

export function hasOpaqueNitroContributors(options: any): boolean {
  const modules = findProperty(options, "modules");
  const hooks = findProperty(options, "hooks");
  return (
    hasOpaqueKeys(options) ||
    hasEnvironmentOverrides(options) ||
    findProperty(options, "extends") !== undefined ||
    (modules !== undefined &&
      (modules.type !== "ArrayExpression" || modules.elements.length > 0)) ||
    (hooks !== undefined && (hooks.type !== "ObjectExpression" || hooks.properties.length > 0))
  );
}

export function literalStringArray(node: any): string[] | undefined {
  if (node?.type !== "ArrayExpression") return undefined;
  const entries = node.elements.map(literalValue) as Array<string | boolean | null>;
  return entries.every((entry) => typeof entry === "string") ? entries : undefined;
}

export function nitroScanDirs(ctx: RuleContext): string[] {
  const key = "nitro:scan-dirs";
  const cached = ctx.cache.get<string[]>(key);
  if (cached) return cached;
  const dirs = nitroServerDirs(ctx);
  const base = nitroMajor(ctx) === 2 ? (dirs[0] ?? ctx.project.root) : ctx.project.root;
  const additional = nitroConfigSources(ctx).flatMap(({ nitro }) =>
    (literalStringArray(findProperty(nitro, "scanDirs")) ?? []).map((dir) => resolve(base, dir)),
  );
  const result = [...new Set([...dirs, ...additional])];
  ctx.cache.set(key, result);
  return result;
}

export function isNitroRuntimeFile(ctx: RuleContext, file: string): boolean {
  return nitroScanDirs(ctx).some((dir) => isInside(dir, file));
}

export function isNitroRouteFile(ctx: RuleContext, file: string): boolean {
  const sources = nitroConfigSources(ctx);
  const subdirs = ["apiDir", "routesDir"].flatMap((key) => {
    const values = sources.map(({ nitro }) => findProperty(nitro, key)).filter(Boolean);
    if (!values.length) return [key === "apiDir" ? "api" : "routes"];
    return values.map(literalValue).filter((value): value is string => typeof value === "string");
  });
  return nitroScanDirs(ctx).some((dir) =>
    subdirs.some((subdir) => isInside(resolve(dir, subdir), file)),
  );
}

export function isNitroHandlerFile(ctx: RuleContext, file: string): boolean {
  if (
    isNitroRouteFile(ctx, file) ||
    nitroScanDirs(ctx).some((dir) => isInside(resolve(dir, "middleware"), file))
  )
    return true;
  return nitroConfigSources(ctx).some(({ nitro }) => {
    const handlers = findProperty(nitro, "handlers");
    return (
      handlers?.type === "ArrayExpression" &&
      handlers.elements.some((entry: any) => {
        const handler = literalValue(findProperty(entry, "handler"));
        return typeof handler === "string" && resolve(ctx.project.root, handler) === file;
      })
    );
  });
}

function isInside(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return !!path && !isAbsolute(path) && path !== ".." && !path.startsWith("../");
}

export function isDevRoute(ctx: RuleContext, file: string): boolean {
  return /\.dev\.[cm]?[jt]sx?$/.test(file) && isNitroRouteFile(ctx, file);
}

export function scannedNitroModuleDirs(ctx: RuleContext): string[] {
  const dirs = nitroScanDirs(ctx).map((dir) => resolve(dir, "modules"));
  if (nitroMajor(ctx) === 3) dirs.push(resolve(ctx.project.root, "modules"));
  return [...new Set(dirs)].filter((dir) =>
    ctx.fs
      .readDirRecursive(dir)
      ?.some((path) => /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path)),
  );
}

const PRESET_ASSIGNMENT =
  /(?:^|[;&|\n])\s*(?:(?:export|env|cross-env(?:-shell)?|set)\s+)?(?:\w+=\S+\s+)*["']?(?:NITRO_PRESET|SERVER_PRESET)\s*=/;

/**
 * The deployment preset a production build uses, kebab-cased as Nitro resolves it. Undefined
 * when the config does not name one statically, names it per environment, or a package script
 * can override it. Scripts are not used as positive evidence of a deployment target.
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
    if (
      source.nuxt &&
      (hasOpaqueKeys(source.nuxt) ||
        hasEnvironmentOverrides(source.nuxt) ||
        findProperty(source.nuxt, "extends") !== undefined ||
        findProperty(source.nuxt, "hooks") !== undefined)
    )
      return undefined;
    if (hasOpaqueNitroContributors(source.nitro)) return undefined;
    const value = findProperty(source.nitro, "preset");
    if (value === undefined) continue;
    const preset = literalValue(value);
    if (typeof preset !== "string") return undefined;
    presets.add(kebabPreset(preset));
  }
  if (presets.size !== 1 || scannedNitroModuleDirs(ctx).length) return undefined;
  const manifest = ctx.fs.readJson(resolve(ctx.project.root, "package.json")) as {
    scripts?: Record<string, unknown>;
  } | null;
  for (const script of Object.values(manifest?.scripts ?? {})) {
    if (typeof script !== "string") continue;
    const command = script.trim();
    if (
      PRESET_ASSIGNMENT.test(command) ||
      (/\b(?:build|generate|prepare)\b/.test(command) &&
        /(?:^|\s)--preset(?:[=\s]|$)/.test(command))
    )
      return undefined;
  }
  return [...presets][0];
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
