import { relative, resolve } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import {
  findProperty,
  hasEnvironmentOverrides,
  hasOpaqueKeys,
  nitroConfigSources,
} from "./nitro-config.js";
import { literalValue, nitroServerFile, propertyKey, unwrapConfig } from "./server-layout.js";

export interface NitroStorageMount {
  /** The mount base as unstorage normalizes it, without the trailing colon. */
  base: string;
  /** Where the mount comes from. `devStorage` mounts exist only in dev and prerender builds. */
  source: "storage" | "devStorage" | "kv" | "builtin";
  /** The config file that declares it, relative to the project root. */
  file?: string;
}

/** Project Inventory fact: the storage mounts Nitro config declares. */
export interface NitroStorageInventory {
  mounts: NitroStorageMount[];
  /** False when config Doctor cannot read, a module, or runtime code may add mounts. */
  complete: boolean;
}

// Bases Nitro and Nuxt reserve: server assets, the data and cache stores, the dev-only source
// mounts, and Nuxt's prerender cache.
const NITRO_BUILTIN_BASES = ["assets", "data", "cache", "root", "src", "build"];
const NUXT_BUILTIN_BASES = ["internal:nuxt:prerender"];
const CONFIG_KEYS = [
  ["storage", "storage"],
  ["devStorage", "devStorage"],
  ["kv", "kv"],
] as const;
const MOUNTS_STORAGE = /\bdevStorage\b|\.storage\b|\bstorage\s*:|\.mount\s*\(/;
const RUNTIME_MOUNT = /\.mount\s*\(/;
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MODULE_SCRIPT = /\.(?:[cm]?js|[cm]?ts)$/;
const MAX_MODULE_FILES = 400;

/**
 * The storage mounts a production build gets from config, recorded in the Project Inventory as
 * `nitroStorage`. Anything Doctor cannot read leaves the inventory incomplete and adds an
 * evidence gap.
 */
export async function nitroStorageInventory(ctx: RuleContext): Promise<NitroStorageInventory> {
  const key = "nitro:storage-inventory";
  const cached = ctx.cache.get<NitroStorageInventory>(key);
  if (cached) return cached;
  const project = ctx.project;
  const gaps: string[] = [];
  const mounts: NitroStorageMount[] = [
    ...NITRO_BUILTIN_BASES,
    ...(project.framework === "nuxt" ? NUXT_BUILTIN_BASES : []),
  ].map((base) => ({ base, source: "builtin" as const }));
  const sources = nitroConfigSources(ctx);
  for (const source of sources) {
    const file = relative(project.root, source.file);
    if (!source.nitro || source.nuxt === null) {
      gaps.push(file);
      continue;
    }
    if (source.nuxt && !readNuxtModules(ctx, source.nuxt, gaps)) gaps.push(file);
    if (
      hasOpaqueKeys(source.nitro) ||
      hasEnvironmentOverrides(source.nitro) ||
      (!source.nuxt && findProperty(source.nitro, "modules") !== undefined)
    ) {
      gaps.push(file);
      continue;
    }
    for (const [name, kind] of CONFIG_KEYS) {
      const value = findProperty(source.nitro, name);
      if (value === undefined) continue;
      const object = unwrapConfig(value);
      if (!object || hasOpaqueKeys(object)) {
        gaps.push(file);
        continue;
      }
      for (const property of object.properties) {
        const base = normalizeBase(propertyKey(property.key)!);
        if (base) mounts.push({ base, source: kind, file });
      }
    }
  }
  if (project.framework === "nuxt") gaps.push(...localNuxtExtensions(ctx));
  for (const file of await ctx.inventory.sourcePaths()) {
    if (!SCRIPT.test(file) || !nitroServerFile(ctx, file)) continue;
    if (RUNTIME_MOUNT.test(ctx.fs.readText(file) ?? "")) gaps.push(relative(project.root, file));
  }
  const inventory: NitroStorageInventory = { mounts, complete: gaps.length === 0 };
  ctx.cache.set(key, inventory);
  project.inventory = { ...project.inventory, nitroStorage: inventory };
  if (gaps.length) {
    project.evidenceGaps = [
      ...(project.evidenceGaps ?? []),
      {
        source: "vite-doctor/nitro",
        message:
          "Doctor could not list every Nitro storage mount: config it cannot read statically, a module or layer, or runtime code may mount storage.",
        files: [...new Set(gaps)],
      },
    ];
  }
  return inventory;
}

/** Whether no mount serves keys under `base`, so useStorage(base) falls back to memory. */
export function isUndeclaredBase(inventory: NitroStorageInventory, base: string) {
  const key = `${normalizeBase(base)}:`;
  return !inventory.mounts.some(
    (mount) =>
      mount.source !== "devStorage" &&
      (key.startsWith(`${mount.base}:`) || `${mount.base}:`.startsWith(key)),
  );
}

// unstorage's normalizeKey: drop the query, use colons as separators, trim them.
export function normalizeBase(key: string) {
  return (key.split("?")[0] ?? "").replace(/[/\\]/g, ":").replace(/:+/g, ":").replace(/^:|:$/g, "");
}

/**
 * Reads the Nuxt config's layers and modules. False when one of them may configure storage or
 * Doctor cannot tell.
 */
function readNuxtModules(ctx: RuleContext, nuxt: any, gaps: string[]): boolean {
  if (hasOpaqueKeys(nuxt) || hasEnvironmentOverrides(nuxt)) return false;
  if (findProperty(nuxt, "extends") !== undefined) return false;
  const modules = findProperty(nuxt, "modules");
  if (modules === undefined) return true;
  if (modules.type !== "ArrayExpression") return false;
  for (const element of modules.elements) {
    const entry = element?.type === "ArrayExpression" ? element.elements[0] : element;
    const name = literalValue(entry);
    if (typeof name !== "string") return false;
    const files = moduleFiles(ctx, name);
    if (!files) return false;
    const match = files.find((file) => MOUNTS_STORAGE.test(ctx.fs.readText(file) ?? ""));
    if (match) {
      gaps.push(relative(ctx.project.root, match));
      return false;
    }
  }
  return true;
}

/** The script files of a Nuxt module, or undefined when Doctor cannot find or bound them. */
function moduleFiles(ctx: RuleContext, name: string): string[] | undefined {
  const root = ctx.project.root;
  if (name.startsWith(".") || name.startsWith("/")) {
    const base = resolve(root, name);
    const file = ["", ".ts", ".mjs", ".js", "/index.ts", "/index.mjs", "/index.js"]
      .map((extension) => base + extension)
      .find((path) => ctx.fs.stat(path)?.isFile());
    return file ? [file] : undefined;
  }
  // Aliases such as ~ and @ resolve through Nuxt config Doctor does not evaluate here.
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) return undefined;
  const packageDir = resolve(root, "node_modules", name);
  if (!ctx.fs.exists(resolve(packageDir, "package.json"))) return undefined;
  const dir = ctx.fs.stat(resolve(packageDir, "dist"))?.isDirectory()
    ? resolve(packageDir, "dist")
    : packageDir;
  const files = (ctx.fs.readDirRecursive(dir) ?? [])
    .filter((path) => MODULE_SCRIPT.test(path) && !path.split("/").includes("node_modules"))
    .map((path) => resolve(dir, path));
  return files.length > MAX_MODULE_FILES ? undefined : files;
}

// Local modules and layers Nuxt registers from the modules/ and layers/ directories.
function localNuxtExtensions(ctx: RuleContext): string[] {
  const root = ctx.project.root;
  const gaps: string[] = [];
  if (ctx.fs.stat(resolve(root, "layers"))?.isDirectory()) gaps.push("layers");
  for (const path of ctx.fs.readDirRecursive(resolve(root, "modules")) ?? []) {
    const file = resolve(root, "modules", path);
    if (MODULE_SCRIPT.test(path) && MOUNTS_STORAGE.test(ctx.fs.readText(file) ?? ""))
      gaps.push(relative(root, file));
  }
  return gaps;
}
