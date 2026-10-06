import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { basename, dirname, join, relative, resolve } from "pathe";
import { parse } from "yaml";
import type { DoctorFramework, WorkspacePackage } from "../primitives.js";

const FRAMEWORK_PRECEDENCE: DoctorFramework[] = ["nuxt", "nitro", "vue", "vite"];

interface PackageManifest {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Project Inventory for the workspace root and every workspace package it declares through
 * `pnpm-workspace.yaml` or the `workspaces` field. The root is always the first entry.
 */
export async function detectWorkspacePackages(
  root: string,
  rootFramework?: DoctorFramework,
): Promise<WorkspacePackage[]> {
  const manifest = readManifest(join(root, "package.json"));
  const rootPackage = describePackage(root, ".", manifest);
  if (rootFramework) rootPackage.framework = rootFramework;
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

export function workspaceFramework(packages: readonly WorkspacePackage[]): DoctorFramework {
  const frameworks = new Set(packages.map((item) => item.framework));
  return FRAMEWORK_PRECEDENCE.find((framework) => frameworks.has(framework)) ?? "vite";
}

export function workspaceFrameworkPackage(
  packages: readonly WorkspacePackage[],
  framework: DoctorFramework,
): WorkspacePackage | undefined {
  if (framework === "nuxt" && packages.filter((item) => item.framework === "nuxt").length > 1) {
    throw new Error(
      "Multi-Nuxt workspace runs are not supported. Run Doctor separately from each Nuxt package root.",
    );
  }
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
  return {
    root,
    ...(manifest?.name ? { name: manifest.name } : {}),
    framework: detectPackageFramework(directory, packages),
    packages,
  };
}

function detectPackageFramework(
  directory: string,
  packages: Record<string, string | undefined>,
): DoctorFramework {
  if (packages.nuxt || packages["@nuxt/kit"] || hasConfig(directory, "nuxt.config")) return "nuxt";
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
