import { relative, resolve } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { analyzeScript, scopeDialect } from "../../../core/internal/script-scope.js";
import {
  findProperty,
  hasEnvironmentOverrides,
  hasOpaqueKeys,
  hasOpaqueNitroContributors,
  isDevRoute,
  literalStringArray,
  nitroConfigSources,
  nitroDeployPreset,
  nitroMajor,
  nitroScanDirs,
  scannedNitroModuleDirs,
} from "./nitro-config.js";
import {
  constInitializer,
  isStorageCall,
  memberName,
  unwrapExpression,
  walk,
} from "./nitro-handlers.js";
import { literalValue, propertyKey, unwrapConfig } from "./server-layout.js";

export interface NitroStorageMount {
  /** The mount base as unstorage normalizes it, without the trailing colon. */
  base: string;
  /** Where the mount comes from. `devStorage` mounts exist only in dev and prerender builds. */
  source: "storage" | "devStorage" | "kv" | "builtin" | "bundledStorage";
  /** The config file that declares it, relative to the project root. */
  file?: string;
}

/** Project Inventory fact: the storage mounts Nitro config declares. */
export interface NitroStorageInventory {
  mounts: NitroStorageMount[];
  /** False when config Doctor cannot read, a module, or runtime code may add mounts. */
  complete: boolean;
  /** Built-ins that depend on a deployment preset we could not determine. */
  possibleMounts?: string[];
}

const NITRO_2_NON_NODE = /^(?:cloudflare(?:-|$)|deno(?:-|$))/;
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MODULE_SCRIPT = /\.(?:[cm]?js|[cm]?ts)$/;
const MAX_MODULE_FILES = 400;

/**
 * The storage mounts a production build gets from config, recorded in the Project Inventory as
 * `nitroStorage`. Anything Doctor cannot read leaves the inventory incomplete and adds an
 * evidence gap.
 */
export function nitroStorageInventory(ctx: RuleContext): NitroStorageInventory {
  const key = "nitro:storage-inventory";
  const cached = ctx.cache.get<NitroStorageInventory>(key);
  if (cached) return cached;
  const project = ctx.project;
  const gaps: string[] = [];
  const major = nitroMajor(ctx);
  const preset = nitroDeployPreset(ctx);
  const mounts: NitroStorageMount[] = [{ base: "assets", source: "builtin" }];
  const possibleMounts: string[] = [];
  if (major === 2) {
    for (const base of ["root", "src", "build", "cache"])
      mounts.push({ base, source: "devStorage" });
    if (preset?.startsWith("node-")) mounts.push({ base: "data", source: "builtin" });
    else if (!preset || !NITRO_2_NON_NODE.test(preset)) possibleMounts.push("data");
  } else if (major !== 3) gaps.push("package.json");
  const sources = nitroConfigSources(ctx);
  for (const source of sources) {
    const file = relative(project.root, source.file);
    if (!source.nitro || source.nuxt === null) {
      gaps.push(file);
      continue;
    }
    if (source.nuxt && !readNuxtModules(ctx, source.nuxt, gaps)) gaps.push(file);
    if (hasOpaqueNitroContributors(source.nitro)) {
      gaps.push(file);
      continue;
    }
    const keys = major === 2 ? (["storage", "devStorage"] as const) : (["kv", "storage"] as const);
    if (major === 3 && keys.every((name) => findProperty(source.nitro, name) !== undefined)) {
      gaps.push(file);
      continue;
    }
    for (const name of keys) {
      const value = findProperty(source.nitro, name);
      if (value === undefined) continue;
      const object = unwrapConfig(value);
      if (!object || hasOpaqueKeys(object)) {
        gaps.push(file);
        continue;
      }
      for (const property of object.properties) {
        const base = normalizeBase(propertyKey(property.key)!);
        mounts.push({ base, source: name, file });
      }
    }
    const bundled = findProperty(source.nitro, "bundledStorage");
    if (major === 2 && bundled !== undefined) {
      const bases = literalStringArray(bundled);
      if (!bases) gaps.push(file);
      else
        for (const base of bases)
          mounts.push({ base: normalizeBase(base), source: "bundledStorage", file });
    }
    const plugins = findProperty(source.nitro, "plugins");
    if (plugins !== undefined) {
      const entries = literalStringArray(plugins);
      if (!entries) gaps.push(file);
      else
        for (const entry of entries) {
          const files = moduleFiles(ctx, entry.startsWith("/") ? entry : `./${entry}`);
          if (!files || files.some((file) => mayMountStorage(ctx, file))) gaps.push(file);
        }
    }
    const dirs = findProperty(source.nitro, "scanDirs");
    if (dirs !== undefined && !literalStringArray(dirs)) gaps.push(file);
  }
  if (project.framework === "nuxt") gaps.push(...localNuxtExtensions(ctx));
  gaps.push(...scannedNitroModuleDirs(ctx).map((dir) => relative(project.root, dir)));
  if (!gaps.length) gaps.push(...runtimeMountGaps(ctx));
  const inventory: NitroStorageInventory = { mounts, complete: gaps.length === 0 };
  if (possibleMounts.length) inventory.possibleMounts = possibleMounts;
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

export function storageCoverage(inventory: NitroStorageInventory, base: string, item?: string) {
  const key = [normalizeBase(base), item === undefined ? "" : normalizeBase(item)]
    .filter(Boolean)
    .join(":");
  const prefix = item === undefined && key ? `${key}:` : key;
  const mounts = inventory.mounts.filter((mount) => mount.source !== "devStorage");
  const covers = (mount: string) => !mount || prefix.startsWith(`${mount}:`);
  if (mounts.some((mount) => covers(mount.base))) return "mounted";
  if (inventory.possibleMounts?.some(covers)) return "unknown";
  if (item === undefined && mounts.some((mount) => `${mount.base}:`.startsWith(prefix)))
    return "partial";
  return "unmounted";
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
  const hooks = findProperty(nuxt, "hooks");
  if (
    hooks !== undefined &&
    (hooks.type !== "ObjectExpression" ||
      hasOpaqueKeys(hooks) ||
      hooks.properties.some((property: any) => propertyKey(property.key)?.startsWith("nitro:")))
  )
    return false;
  const modules = findProperty(nuxt, "modules");
  if (modules === undefined) return true;
  if (modules.type !== "ArrayExpression") return false;
  for (const element of modules.elements) {
    const entry = element?.type === "ArrayExpression" ? element.elements[0] : element;
    const name = literalValue(entry);
    if (typeof name !== "string") return false;
    const files = moduleFiles(ctx, name);
    if (!files) return false;
    const match = files.find((file) => mayMountStorage(ctx, file, true));
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
    if (MODULE_SCRIPT.test(path) && mayMountStorage(ctx, file, true))
      gaps.push(relative(root, file));
  }
  return gaps;
}

function runtimeMountGaps(ctx: RuleContext): string[] {
  const visited = new Set<string>();
  const pending = [...nitroScanDirs(ctx)];
  for (const dir of pending) {
    if (visited.has(dir)) continue;
    visited.add(dir);
    const entries = ctx.fs.readDir(dir);
    if (!entries && ctx.fs.stat(dir)?.isDirectory()) return [relative(ctx.project.root, dir)];
    for (const entry of entries ?? []) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const file = resolve(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isSymbolicLink() && ctx.fs.stat(file)?.isDirectory())
        return [relative(ctx.project.root, file)];
      else if (
        SCRIPT.test(entry.name) &&
        !/\.d\.[cm]?ts$/.test(file) &&
        !isDevRoute(ctx, file) &&
        mayMountStorage(ctx, file)
      )
        return [relative(ctx.project.root, file)];
    }
  }
  return [];
}

function mayMountStorage(ctx: RuleContext, file: string, module = false): boolean {
  const text = ctx.fs.readText(file);
  if (text === undefined) return true;
  if (!/\bmount\b/.test(text) && !(module && /\b(?:storage|devStorage|kv|nitro)\b/.test(text)))
    return false;
  const scope = analyzeScript(text, scopeDialect(file));
  if (!scope) return true;
  let found = false;
  walk(scope, scope.ast, (node) => {
    if (found) return;
    if (
      module &&
      ((node.type === "Property" &&
        ["storage", "devStorage", "kv"].includes(propertyKey(node.key) ?? "")) ||
        (node.type === "Literal" &&
          typeof node.value === "string" &&
          node.value.startsWith("nitro:")) ||
        ["storage", "devStorage", "kv"].includes(memberName(node) ?? ""))
    )
      found = true;
    if (node.type !== "CallExpression") return;
    const callee = unwrapExpression(node.callee);
    if (memberName(callee) !== "mount") return;
    const receiver = unwrapExpression(callee.object);
    if (isStorageCall(scope, receiver) || isStorageCall(scope, constInitializer(scope, receiver)))
      found = true;
  });
  return found;
}
