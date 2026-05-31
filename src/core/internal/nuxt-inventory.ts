import { relative, resolve } from "pathe";
import type { NuxtDoctorManifest, NuxtModuleSource } from "../primitives.js";

export interface NuxtProjectInventory {
  importsDirs: string[];
  pluginFiles: string[];
  keyedComposables: string[];
  aliases: Record<string, string>;
  appScanRoots: string[];
  sharedScanRoots: string[];
  hasManifest: boolean;
  pages: Array<{ path?: string; file?: string; name?: string }>;
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
): NuxtProjectInventory {
  return {
    importsDirs: (manifest?.importsDirs ?? fallbackImportsDirs).map((dir) => resolve(root, dir)),
    pluginFiles: (manifest?.pluginFiles ?? []).map((file) => resolve(root, file)),
    keyedComposables: (manifest?.keyedComposables ?? []).map(String),
    aliases: manifest?.aliases ?? {},
    appScanRoots: (manifest?.appScanRoots ?? [manifest?.appDir ?? "app"]).map((dir) =>
      resolve(root, dir),
    ),
    sharedScanRoots: (manifest?.sharedScanRoots ?? ["shared/utils", "shared/types"]).map((dir) =>
      resolve(root, dir),
    ),
    hasManifest: Boolean(manifestPath),
    pages: manifest?.pages ?? [],
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
