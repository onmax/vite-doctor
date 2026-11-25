import { existsSync, globSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { basename, dirname, join, relative, resolve } from "pathe";
import { parse } from "yaml";
import type { DoctorFramework, WorkspacePackage } from "../primitives.js";
import { detectPackageModule } from "./nuxt-module-inventory.js";
import { declaredRuntimes } from "./runtime-packages.js";

const FRAMEWORK_PRECEDENCE: DoctorFramework[] = ["nuxt", "nitro", "vue", "vite"];

interface PackageManifest {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  scripts?: Record<string, string>;
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
  if (!patterns.length) return withoutClientApps(root, [rootPackage]);
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
  return withoutClientApps(root, [
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
  ]);
}

/** Drops server-rendering evidence from packages that mount their own browser app. */
function withoutClientApps(root: string, packages: WorkspacePackage[]): WorkspacePackage[] {
  for (const item of packages)
    if (item.ssr && mountsClientApp(root, item.root, packages)) delete item.ssr;
  return packages;
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
  const runtimes = declaredRuntimes(manifest, join(directory, "package.json"));
  const nuxtIntegration = framework !== "nuxt" && shipsNuxtModule(manifest, packages);
  const ssr =
    framework === "nuxt" || !shipsVue(manifest)
      ? undefined
      : (manifestSsrEvidence(manifest) ??
        (nuxtIntegration
          ? "it ships a Nuxt module, and Nuxt server-renders components by default"
          : undefined));
  return {
    root,
    ...(manifest?.name ? { name: manifest.name } : {}),
    framework,
    ...(nuxtIntegration ? { nuxtIntegration: true } : {}),
    packages,
    ...(runtimes.length ? { declaredRuntimes: runtimes } : {}),
    ...(ssr ? { ssr } : {}),
  };
}

const SSR_RENDERERS =
  /^(vitepress|vuepress|@vuepress\/.*|@vue\/server-renderer|vite-ssg|vite-plugin-ssr|vike|nuxt)$/;
const SSR_SCRIPTS = /\b(vitepress|vuepress|vite-ssg|vike|vite\s+build\s+--ssr)\b/;

/**
 * Why a package's own manifest says its Vue components render on a server: an SSR renderer or
 * framework among its dependencies or scripts, a `./nuxt` export, or a `nuxt` peer. A Nuxt app
 * server-renders its components by default, so a library built for Nuxt is server-rendered too.
 */
export function manifestSsrEvidence(
  manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    exports?: unknown;
  } | null,
): string | undefined {
  if (!manifest) return undefined;
  const exports = manifest.exports;
  if (isRecord(exports) && "./nuxt" in exports)
    return "its package.json exports ./nuxt, and Nuxt server-renders components by default";
  if (manifest.peerDependencies?.nuxt)
    return "it declares a nuxt peer dependency, and Nuxt server-renders components by default";
  for (const key of ["dependencies", "optionalDependencies", "devDependencies"] as const) {
    const name = Object.keys(manifest[key] ?? {}).find((item) => SSR_RENDERERS.test(item));
    if (name) return `it depends on ${name}`;
  }
  const script = Object.values(manifest.scripts ?? {})
    .map((item) => SSR_SCRIPTS.exec(item)?.[1])
    .find(Boolean);
  return script ? `a package script runs ${script}` : undefined;
}

function shipsVue(manifest: PackageManifest | null): boolean {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
    (key) => Boolean(manifest?.[key as "dependencies"]?.vue),
  );
}

const CLIENT_APP_SOURCES = "**/*.{ts,mts,js,mjs,tsx,jsx}";
const NON_APP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "examples",
  "playground",
  "scripts",
]);

/**
 * Whether the package mounts its own browser app with `createApp(...).mount()` and never renders
 * Vue on a server. Its components are built for that app, so a `./nuxt` export or a Nuxt consumer
 * says nothing about how they render.
 */
function mountsClientApp(
  root: string,
  packageRoot: string,
  packages: readonly WorkspacePackage[],
): boolean {
  let cache = clientApps.get(packages);
  if (!cache) clientApps.set(packages, (cache = new Map()));
  let mounts = cache.get(packageRoot);
  if (mounts === undefined)
    cache.set(packageRoot, (mounts = scanClientApp(root, packageRoot, packages)));
  return mounts;
}

const clientApps = new WeakMap<readonly WorkspacePackage[], Map<string, boolean>>();

function scanClientApp(
  root: string,
  packageRoot: string,
  packages: readonly WorkspacePackage[],
): boolean {
  const directory = join(root, packageRoot);
  // Workspace packages nested in this one, such as every package under the workspace root.
  const nested = new Set(
    packages
      .filter(
        (item) =>
          item.root !== packageRoot &&
          (packageRoot === "." || item.root.startsWith(`${packageRoot}/`)),
      )
      .map((item) => join(root, item.root)),
  );
  let mounts = false;
  for (const file of globSync(CLIENT_APP_SOURCES, {
    cwd: directory,
    exclude: (entry) =>
      NON_APP_DIRECTORIES.has(basename(String(entry))) ||
      nested.has(resolve(directory, String(entry))) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(String(entry)),
  })) {
    let text: string;
    try {
      text = readFileSync(join(directory, String(file)), "utf8");
    } catch {
      continue;
    }
    if (!/createApp|createSSRApp|renderTo/.test(text)) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/.*$/gm, "$1");
    if (/\b(createSSRApp|renderToString|renderToWebStream|renderToNodeStream)\s*\(/.test(code))
      return false;
    mounts ||= /\bcreateApp\s*\(/.test(code) && /\.mount\s*\(/.test(code);
  }
  return mounts;
}

/**
 * Marks workspace packages that a server-rendered package depends on, directly or through other
 * workspace packages, as server-rendered too: their components and composables run inside that
 * package's SSR render. Only packages that ship Vue code take part. A Nuxt app bundles its devDependencies, a library only its runtime ones.
 * `serverRenders` says whether a Nuxt package renders on the server.
 */
export function addConsumerSsrEvidence(
  root: string,
  packages: readonly WorkspacePackage[],
  serverRenders: (item: WorkspacePackage) => boolean,
): void {
  const byName = new Map(
    packages.flatMap((item) => (item.name ? [[item.name, item] as const] : [])),
  );
  const queue = packages.filter((item) =>
    item.framework === "nuxt" ? serverRenders(item) : item.ssr !== undefined,
  );
  for (let index = 0; index < queue.length; index++) {
    const consumer = queue[index]!;
    const manifest =
      consumer.framework === "nuxt"
        ? null
        : readManifest(join(root, consumer.root, "package.json"));
    const names =
      consumer.framework === "nuxt"
        ? Object.keys(consumer.packages)
        : [
            ...Object.keys(manifest?.dependencies ?? {}),
            ...Object.keys(manifest?.optionalDependencies ?? {}),
            ...Object.keys(manifest?.peerDependencies ?? {}),
          ];
    for (const name of names) {
      const dependency = byName.get(name);
      if (!dependency || dependency === consumer || dependency.framework === "nuxt") continue;
      if (dependency.ssr !== undefined) continue;
      if (
        !shipsVue(readManifest(join(root, dependency.root, "package.json"))) ||
        mountsClientApp(root, dependency.root, packages)
      )
        continue;
      dependency.ssr =
        consumer.framework === "nuxt"
          ? `the Nuxt app ${consumer.root} depends on it`
          : `the server-rendered package ${consumer.root} depends on it`;
      queue.push(dependency);
    }
  }
}

function detectPackageFramework(
  directory: string,
  manifest: PackageManifest | null,
  packages: Record<string, string | undefined>,
): DoctorFramework {
  if (isNuxtApp(directory, manifest, packages)) return "nuxt";
  if (
    (packages.nuxt || packages["@nuxt/kit"] || packages["@nuxt/module-builder"]) &&
    detectPackageModule(directory)
  )
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
    if (isRecord(value.scripts)) {
      manifest.scripts = Object.fromEntries(
        Object.entries(value.scripts).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
    for (const key of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const dependencies = value[key];
      if (
        isRecord(dependencies) &&
        Object.values(dependencies).every((item) => typeof item === "string")
      ) {
        manifest[key] = dependencies as Record<string, string>;
      }
    }
    if (isRecord(value.peerDependenciesMeta)) {
      manifest.peerDependenciesMeta = Object.fromEntries(
        Object.entries(value.peerDependenciesMeta).map(([name, meta]) => [
          name,
          { optional: isRecord(meta) && meta.optional === true },
        ]),
      );
    }
    return manifest;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
