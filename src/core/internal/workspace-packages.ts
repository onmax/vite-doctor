import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { basename, dirname, join, relative, resolve } from "pathe";
import { parse } from "yaml";
import type { DoctorFramework, WorkspacePackage } from "../primitives.js";
import { detectPackageModule } from "./nuxt-module-inventory.js";

const FRAMEWORK_PRECEDENCE: DoctorFramework[] = ["nuxt", "nitro", "vue", "vite"];

interface PackageManifest {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: unknown;
}

/**
 * Project Inventory for the workspace root and every workspace package it declares through
 * `pnpm-workspace.yaml` or the `workspaces` field. The root is always the first entry.
 */
export async function detectWorkspacePackages(root: string): Promise<WorkspacePackage[]> {
  const manifest = readManifest(join(root, "package.json"));
  const rootPackage = describePackage(root, ".", manifest);
  const patterns = workspacePatterns(root, manifest);
  if (!patterns.length) return [rootPackage];
  const include = patterns.filter((pattern) => !pattern.startsWith("!"));
  const exclude = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  const roots = new Set<string>();
  for await (const file of glob(
    include.map((pattern) => `${pattern.replace(/\/+$/, "")}/package.json`),
    { cwd: root, exclude: (entry) => basename(String(entry)) === "node_modules" },
  )) {
    const packageRoot = dirname(relative(root, resolve(root, String(file))));
    if (packageRoot === "." || packageRoot.startsWith("..")) continue;
    if (exclude.some((pattern) => matchesGlob(packageRoot, pattern))) continue;
    roots.add(packageRoot);
  }
  return [
    rootPackage,
    ...[...roots]
      .sort()
      .map((packageRoot) =>
        describePackage(
          join(root, packageRoot),
          packageRoot,
          readManifest(join(root, packageRoot, "package.json")),
        ),
      ),
  ];
}

/**
 * The frameworks whose Rule Packs a workspace package activates. A Nuxt integration ships Vue
 * components, Nitro handlers and module code into Nuxt apps, so it activates what a Nuxt app does.
 */
export function packageFrameworks(item: WorkspacePackage): DoctorFramework[] {
  return item.nuxtIntegration ? [item.framework, "nuxt"] : [item.framework];
}

export function workspaceFramework(packages: readonly WorkspacePackage[]): DoctorFramework {
  const frameworks = new Set(packages.map((item) => item.framework));
  return FRAMEWORK_PRECEDENCE.find((framework) => frameworks.has(framework)) ?? "vite";
}

/**
 * The Nuxt workspace package that owns the run's `project.nuxt`: the root when it is a Nuxt app,
 * otherwise the only Nuxt workspace package. Several nested Nuxt apps have no single owner, so
 * each one keeps its own Nuxt Project Inventory.
 */
export function nuxtInventoryOwner(
  packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
  const nuxtPackages = packages.filter((item) => item.framework === "nuxt");
  return (
    nuxtPackages.find((item) => item.root === ".") ??
    (nuxtPackages.length === 1 ? nuxtPackages[0] : undefined)
  );
}

/** The package whose `package.json` resolves the run framework's runtime graph. */
export function runtimeGraphPackage(
  packages: readonly WorkspacePackage[],
  framework: DoctorFramework,
): WorkspacePackage | undefined {
  return (
    packages.find((item) => item.root === "." && item.framework === framework) ??
    packages.find((item) => item.framework === framework)
  );
}

/** Longest workspace package root that contains `relativePath`, or `.` for the workspace root. */
export function owningWorkspacePackage(
  packages: readonly WorkspacePackage[],
  relativePath: string,
): string {
  let owner = ".";
  for (const item of packages) {
    if (item.root === "." || item.root.length <= owner.length) continue;
    if (relativePath === item.root || relativePath.startsWith(`${item.root}/`)) owner = item.root;
  }
  return owner;
}

function describePackage(
  directory: string,
  root: string,
  manifest: PackageManifest | null,
): WorkspacePackage {
  const packages = {
    ...manifest?.dependencies,
    ...manifest?.optionalDependencies,
    ...manifest?.devDependencies,
  };
  const framework = detectPackageFramework(directory, manifest, packages);
  return {
    root,
    ...(manifest?.name ? { name: manifest.name } : {}),
    framework,
    ...(framework !== "nuxt" && shipsNuxtModule(manifest, packages)
      ? { nuxtIntegration: true }
      : {}),
    packages,
  };
}

function detectPackageFramework(
  directory: string,
  manifest: PackageManifest | null,
  packages: Record<string, string | undefined>,
): DoctorFramework {
  if (isNuxtApp(directory, manifest, packages)) return "nuxt";
  if ((packages["@nuxt/kit"] || packages["@nuxt/module-builder"]) && detectPackageModule(directory))
    return "nuxt";
  if (packages.nitro || packages.nitropack || hasConfig(directory, "nitro.config")) return "nitro";
  if (
    packages.vue ||
    existsSync(join(directory, "src/App.vue")) ||
    existsSync(join(directory, "app.vue"))
  ) {
    return "vue";
  }
  return "vite";
}

/**
 * A Nuxt app or layer: a `nuxt.config`, the Doctor manifest Nuxt writes, a runtime `nuxt`
 * dependency, or the app entry Nuxt renders. Packages that ship a Nuxt module keep `nuxt` in
 * devDependencies to build and test against it, which says nothing about their own code.
 * A Nuxt module package is Nuxt too, so the module-authoring Rules read its module definition.
 */
function isNuxtApp(
  directory: string,
  manifest: PackageManifest | null,
  packages: Record<string, string | undefined>,
): boolean {
  if (hasConfig(directory, "nuxt.config")) return true;
  if (existsSync(join(directory, ".nuxt/doctor.manifest.json"))) return true;
  if (!packages.nuxt) return false;
  if (manifest?.dependencies?.nuxt || manifest?.optionalDependencies?.nuxt) return true;
  return ["app.vue", "pages", "app/app.vue", "app/pages"].some((entry) =>
    existsSync(join(directory, entry)),
  );
}

function shipsNuxtModule(
  manifest: PackageManifest | null,
  packages: Record<string, string | undefined>,
): boolean {
  if (packages["@nuxt/kit"]) return true;
  const exports = manifest?.exports;
  return isRecord(exports) && "./nuxt" in exports;
}

function hasConfig(directory: string, basename: string): boolean {
  return [".ts", ".mts", ".js", ".mjs", ".cjs"].some((extension) =>
    existsSync(join(directory, basename + extension)),
  );
}

function workspacePatterns(root: string, manifest: PackageManifest | null): string[] {
  if (existsSync(join(root, "pnpm-workspace.yaml"))) {
    return readPnpmWorkspacePatterns(root);
  }
  const declared = Array.isArray(manifest?.workspaces)
    ? manifest.workspaces
    : (manifest?.workspaces?.packages ?? []);
  return declared.filter(
    (pattern): pattern is string => typeof pattern === "string" && pattern.length > 0,
  );
}

function readPnpmWorkspacePatterns(root: string): string[] {
  try {
    const value: unknown = parse(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
    if (!isRecord(value) || !Array.isArray(value.packages)) return [];
    return value.packages.filter(
      (pattern): pattern is string => typeof pattern === "string" && pattern.length > 0,
    );
  } catch {
    return [];
  }
}

function readManifest(file: string): PackageManifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(value)) return null;
    const manifest: PackageManifest = {};
    if (typeof value.name === "string") manifest.name = value.name;
    if (value.exports !== undefined) manifest.exports = value.exports;
    if (
      Array.isArray(value.workspaces) &&
      value.workspaces.every((item) => typeof item === "string")
    ) {
      manifest.workspaces = value.workspaces;
    } else if (isRecord(value.workspaces) && Array.isArray(value.workspaces.packages)) {
      const packages = value.workspaces.packages;
      if (packages.every((item) => typeof item === "string")) {
        manifest.workspaces = { packages };
      }
    }
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      const dependencies = value[key];
      if (
        isRecord(dependencies) &&
        Object.values(dependencies).every((item) => typeof item === "string")
      ) {
        manifest[key] = dependencies as Record<string, string>;
      }
    }
    return manifest;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
