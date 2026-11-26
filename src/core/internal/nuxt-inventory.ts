import { existsSync, readFileSync, statSync } from "node:fs";
import ignore from "ignore";
import { join, relative, resolve } from "pathe";
import { globSync } from "tinyglobby";
import { isNuxtManifestCurrent, nuxtServerInventory } from "./runtime-graph.js";
import { nuxtAppInputSignature } from "./nuxt-app-inputs.js";
import { sha256 } from "./utils.js";
import type {
  NuxtAppInventoryKind,
  NuxtAppRegistrationIgnore,
  NuxtAppRegistrationSnapshot,
  NuxtDoctorManifest,
  NuxtKeyedComposable,
  NuxtModuleSource,
  NuxtResolvedMiddleware,
  NuxtResolvedRoute,
} from "../primitives.js";

export interface NuxtProjectInventory {
  scannedComposableFiles?: string[];
  importsDirs: string[];
  pluginFiles: string[];
  serverAppEntryFiles?: string[];
  resolvedPlugins?: NuxtDoctorManifest["resolvedPlugins"];
  resolvedMiddleware?: NuxtDoctorManifest["resolvedMiddleware"];
  resolvedComponents?: NuxtDoctorManifest["resolvedComponents"];
  hasServerPageIslands?: boolean;
  componentIslands?: NuxtDoctorManifest["componentIslands"];
  keyedComposables: NuxtKeyedComposable[];
  aliases: Record<string, string>;
  autoImportTransform?: {
    include: Array<{ source: string; flags: string }>;
    exclude: Array<{ source: string; flags: string }>;
  };
  appScanRoots: string[];
  sharedScanRoots: string[];
  hasManifest: boolean;
  isCurrent: boolean;
  serverHandlers: NuxtDoctorManifest["serverHandlers"];
  resolvedServerHandlers?: NuxtDoctorManifest["serverHandlers"];
  resolvedRouteRules?: Record<string, unknown>;
  routeRulePagesCurrent?: boolean;
  nitroPreset?: string;
  pages: NonNullable<NuxtDoctorManifest["pages"]>;
  middleware?: NuxtResolvedMiddleware[];
  routes?: NuxtResolvedRoute[];
  routerOptionsFiles?: string[];
  resolvedApp?: NuxtDoctorManifest["resolvedApp"];
  resolvedAppCurrent: Record<NuxtAppInventoryKind, boolean>;
  prerenderRoutes: string[];
  buildManifest?: {
    hasBuildManifest: boolean;
    chunks: Array<{ file?: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean }>;
  };
  evidence: {
    routeGraph: boolean;
    buildManifest: boolean;
    prerenderRoutes: number;
    serverRoutes: number;
  };
}

export function createNuxtProjectInventory(
  root: string,
  manifest: NuxtDoctorManifest | null,
  manifestPath?: string,
  fallbackImportsDirs: string[] = [],
  isCurrent = isNuxtManifestCurrent(root, manifest),
): NuxtProjectInventory {
  const inputs = manifest?.resolvedApp?.inputs;
  const appInventoryCurrent = (kind: NuxtAppInventoryKind) => {
    const input = inputs?.[kind];
    return Boolean(
      isCurrent && input?.signature && input.signature === nuxtAppInputSignature(root, input),
    );
  };
  const discovery = isCurrent && registrationFilter(root, manifest?.appRegistrationIgnore);
  const current = (kind: "components" | "pages" | "plugins") =>
    discovery && registrationIsCurrent(root, discovery, manifest?.appRegistration?.[kind]);
  return {
    scannedComposableFiles: manifest?.scannedComposableFiles?.map((file) => resolve(root, file)),
    importsDirs: (manifest?.importsDirs ?? fallbackImportsDirs).map((dir) => resolve(root, dir)),
    pluginFiles: (manifest?.pluginFiles ?? []).map((file) => resolve(root, file)),
    serverAppEntryFiles: discovery
      ? manifest?.serverAppEntryFiles?.map((file) => resolve(root, file))
      : undefined,
    resolvedPlugins: current("plugins")
      ? manifest?.resolvedPlugins?.map((plugin) => ({
          ...plugin,
          file: resolve(root, plugin.file),
        }))
      : undefined,
    resolvedComponents: current("components") ? manifest?.resolvedComponents : undefined,
    resolvedMiddleware: isCurrent ? manifest?.resolvedMiddleware : undefined,
    hasServerPageIslands: current("pages") ? manifest?.hasServerPageIslands : undefined,
    componentIslands: isCurrent ? manifest?.componentIslands : undefined,
    keyedComposables: keyedComposables(root, manifest?.keyedComposables),
    aliases: manifest?.aliases ?? {},
    autoImportTransform: manifest?.autoImportTransform,
    appScanRoots: (manifest?.appScanRoots ?? [manifest?.appDir ?? "app"]).map((dir) =>
      resolve(root, dir),
    ),
    sharedScanRoots: (manifest?.sharedScanRoots ?? ["shared/utils", "shared/types"]).map((dir) =>
      resolve(root, dir),
    ),
    hasManifest: Boolean(manifestPath),
    isCurrent,
    serverHandlers: (manifest?.serverHandlers ?? []).map((handler) => ({
      ...handler,
      file: resolve(root, handler.file),
    })),
    resolvedServerHandlers: manifest?.resolvedServerHandlers?.map((handler) => ({
      ...handler,
      file: resolve(root, handler.file),
    })),
    resolvedRouteRules: manifest?.resolvedRouteRules,
    routeRulePagesCurrent: manifest?.resolvedRouteRules
      ? routeRulePagesCurrent(root, manifest)
      : undefined,
    nitroPreset: manifest?.nitroPreset,
    pages: manifest?.pages ?? [],
    resolvedApp: manifest?.resolvedApp,
    resolvedAppCurrent: {
      pages: appInventoryCurrent("pages"),
      layouts: appInventoryCurrent("layouts"),
      mainComponent: appInventoryCurrent("mainComponent"),
    },
    middleware: manifest?.middleware?.map((entry) => ({
      ...entry,
      path: resolve(root, entry.path),
    })),
    routes: manifest?.routes?.map((route) =>
      route.file ? { ...route, file: resolve(root, route.file) } : route,
    ),
    routerOptionsFiles: manifest?.routerOptionsFiles?.map((file) => resolve(root, file)),
    prerenderRoutes: manifest?.prerenderRoutes ?? [],
    buildManifest: manifest?.buildManifest,
    evidence: {
      routeGraph: Boolean(manifest?.pages?.length),
      buildManifest: Boolean(manifest?.buildManifest?.hasBuildManifest),
      prerenderRoutes: manifest?.prerenderRoutes?.length ?? 0,
      serverRoutes: manifest?.serverHandlers?.length ?? 0,
    },
  };
}

function routeRulePagesCurrent(root: string, manifest: NuxtDoctorManifest) {
  if (!manifest.routeRulePageMtimes) return false;
  try {
    return (
      Object.entries(manifest.routeRulePageMtimes).every(
        ([file, mtime]) => mtime !== null && statSync(resolve(root, file)).mtimeMs === mtime,
      ) &&
      Object.entries(manifest.routeRulePageInventory ?? {}).every(
        ([directory, files]) =>
          JSON.stringify(nuxtServerInventory(resolve(root, directory))) === JSON.stringify(files),
      )
    );
  } catch {
    return false;
  }
}

export function nuxtIgnoreFileHash(root: string): string | null {
  const file = join(root, ".nuxtignore");
  return existsSync(file) ? sha256(readFileSync(file, "utf8")) : null;
}

function registrationFilter(root: string, evidence?: NuxtAppRegistrationIgnore) {
  try {
    if (!evidence || evidence.fileHash !== nuxtIgnoreFileHash(root)) return;
    const matcher = ignore(evidence.options).add(evidence.patterns);
    const layerRoots = evidence.layerRoots.map((path) => `${resolve(root, path)}/`);
    return (file: string) => {
      const layer = layerRoots.find((path) => file.startsWith(path));
      const path = layer ? file.slice(layer.length) : relative(root, file);
      return !path || (!layer && path.startsWith("..")) || !matcher.ignores(path);
    };
  } catch {
    return undefined;
  }
}

function registrationIsCurrent(
  root: string,
  included: (file: string) => boolean,
  snapshot?: NuxtAppRegistrationSnapshot,
): boolean {
  if (!snapshot || !Array.isArray(snapshot.directories)) return false;
  try {
    return (
      snapshot.files.every((file) => existsSync(resolve(root, file))) &&
      snapshot.directories.every(({ entries, path, patterns, ignore }) => {
        const cwd = resolve(root, path);
        const current = globSync(patterns, { cwd, ignore })
          .filter((file) => included(join(cwd, file)))
          .sort();
        return JSON.stringify(entries) === JSON.stringify(current);
      })
    );
  } catch {
    return false;
  }
}

const IDENTIFIER_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

// Manifests written before keyed composables were serialized by name hold "[object Object]",
// and later ones hold bare names without the source Nuxt matched them by.
function keyedComposables(root: string, entries: unknown[] = []): NuxtKeyedComposable[] {
  return entries.flatMap((entry) => {
    const { name, source } =
      typeof entry === "string"
        ? { name: entry, source: undefined }
        : ((entry ?? {}) as { name?: unknown; source?: unknown });
    if (typeof name !== "string" || !IDENTIFIER_RE.test(name)) return [];
    return typeof source === "string" ? [{ name, source: resolve(root, source) }] : [{ name }];
  });
}

export function normalizeNuxtModuleSources(sources: NuxtModuleSource[]): NuxtModuleSource[] {
  return sources
    .filter((source) => source.module && source.root)
    .map((source) => ({
      ...source,
      root: resolve(source.root),
      packageDir: source.packageDir ? resolve(source.packageDir) : undefined,
      runtimeDirs: source.runtimeDirs?.map((dir) => resolve(dir)),
      appDirs: source.appDirs?.map((dir) => resolve(dir)),
    }));
}

export function relativeNuxtScanRoot(projectRoot: string, root: string): string {
  let normalized = toPosixPath(root);
  const rootPrefix = `${toPosixPath(projectRoot)}/`;
  if (normalized.startsWith(rootPrefix)) normalized = normalized.slice(rootPrefix.length);
  else normalized = toPosixPath(relative(projectRoot, normalized));
  normalized = normalized.replace(/^~\//, "app/").replace(/^@\//, "app/");
  return normalized.replace(/^\.\//, "");
}

export function matchesNuxtScanRoot(relativePath: string, root: string): boolean {
  if (root.includes("*")) return globToRegExp(root).test(relativePath);
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function globToRegExp(glob: string) {
  const pattern = glob
    .split("/")
    .map((part) =>
      part === "**" ? ".*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

function toPosixPath(path: string) {
  return path.replace(/\\/g, "/");
}
