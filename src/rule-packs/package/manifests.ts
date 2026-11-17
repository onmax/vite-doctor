import { dirname, resolve } from "pathe";
import { valid } from "semver";
import { parse } from "yaml";
import type { RuleContext, SourceRange } from "../../core/primitives.js";
import { isRecord, parsePackageManifest, type PackageManifest } from "./artifacts.js";

export type DependencyField =
  | "dependencies"
  | "optionalDependencies"
  | "peerDependencies"
  | "devDependencies";

export interface WorkspaceManifest {
  /** Path relative to the Doctor Run root, as in `ProjectInfo.workspacePackages`. */
  root: string;
  /** Absolute path of the package.json. */
  file: string;
  text: string;
  manifest: PackageManifest;
}

export interface PackageWorkspace {
  /** The directory that holds `pnpm-workspace.yaml` and `pnpm-lock.yaml`, or the run root. */
  root: string;
  /** Every workspace package, private ones included. */
  packages: WorkspaceManifest[];
  /** pnpm catalogs by name; the default catalog is `default`. */
  catalogs: Map<string, Record<string, string>>;
}

/** The workspace manifests and pnpm catalogs the package rules read, once per Doctor Run. */
export function packageWorkspace(ctx: RuleContext): PackageWorkspace {
  const key = "package:workspace";
  const cached = ctx.cache.get<PackageWorkspace>(key);
  if (cached) return cached;
  const project = ctx.project;
  const packages = (project.workspacePackages ?? [{ root: "." }]).flatMap((item) => {
    const file = resolve(project.root, item.root, "package.json");
    const text = ctx.fs.readText(file);
    if (text === undefined) return [];
    return [{ root: item.root, file, text, manifest: parsePackageManifest(JSON.parse(text)) }];
  });
  let root = project.root;
  for (let directory = project.root; ; directory = dirname(directory)) {
    if (ctx.fs.exists(resolve(directory, "pnpm-workspace.yaml"))) {
      root = directory;
      break;
    }
    if (dirname(directory) === directory) break;
  }
  const workspace = { root, packages, catalogs: readCatalogs(ctx, root) };
  ctx.cache.set(key, workspace);
  return workspace;
}

function readCatalogs(ctx: RuleContext, root: string): Map<string, Record<string, string>> {
  const catalogs = new Map<string, Record<string, string>>();
  const text = ctx.fs.readText(resolve(root, "pnpm-workspace.yaml"));
  if (text === undefined) return catalogs;
  const value: unknown = parse(text);
  if (!isRecord(value)) return catalogs;
  const add = (name: string, entries: unknown) => {
    if (!isRecord(entries)) return;
    const strings = Object.entries(entries).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    catalogs.set(name, { ...catalogs.get(name), ...Object.fromEntries(strings) });
  };
  add("default", value.catalog);
  if (isRecord(value.catalogs))
    for (const [name, entries] of Object.entries(value.catalogs)) add(name, entries);
  return catalogs;
}

export interface ResolvedSpecifier {
  /** The semver range or version consumers see once the package is published. */
  range: string;
  /** Where a `catalog:` range came from, such as `catalogs.ui`. */
  catalog?: string;
}

/**
 * The range a published manifest carries for `specifier`: `catalog:` resolves through
 * `pnpm-workspace.yaml`, `npm:` aliases keep their range, and `workspace:` becomes the version
 * pnpm writes on publish. `undefined` when it cannot be resolved without guessing.
 */
export function publishedRange(
  workspace: PackageWorkspace,
  name: string,
  specifier: string,
): ResolvedSpecifier | undefined {
  if (specifier.startsWith("catalog:")) {
    const catalog = specifier.slice("catalog:".length) || "default";
    const entry = workspace.catalogs.get(catalog)?.[name];
    if (entry === undefined || entry.startsWith("catalog:")) return undefined;
    const resolved = publishedRange(workspace, name, entry);
    return (
      resolved && {
        range: resolved.range,
        catalog: catalog === "default" ? "catalog" : `catalogs.${catalog}`,
      }
    );
  }
  if (specifier.startsWith("npm:")) {
    const at = specifier.lastIndexOf("@");
    return at > "npm:".length ? { range: specifier.slice(at + 1) } : undefined;
  }
  if (specifier.startsWith("workspace:")) {
    const target = specifier.slice("workspace:".length);
    const declared = workspace.packages.find((item) => item.manifest.name === name)?.manifest;
    const version = typeof declared?.version === "string" ? declared.version : undefined;
    if (target === "*") return version ? { range: version } : undefined;
    if (target === "^" || target === "~") return version ? { range: target + version } : undefined;
    return { range: target };
  }
  return { range: specifier };
}

/** The version an exact range pins, such as `3.5.44` for `3.5.44` or `=3.5.44`. */
export function exactVersion(range: string): string | null {
  return valid(range.trim(), { loose: true });
}

/** Offsets of `"name": "specifier"` inside the top-level `field` object of a package.json. */
export function manifestEntryRange(
  ctx: RuleContext,
  file: string,
  text: string,
  field: DependencyField,
  name: string,
): SourceRange {
  const fieldMatch = new RegExp(`"${field}"\\s*:\\s*\\{`).exec(text);
  if (!fieldMatch) return ctx.helpers.rangeFromOffsets(file, text, 0, 0);
  const objectStart = fieldMatch.index + fieldMatch[0].length;
  const objectEnd = text.indexOf("}", objectStart);
  const key = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const entry = new RegExp(`${key}\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, "g");
  entry.lastIndex = objectStart;
  const match = entry.exec(text);
  if (!match || (objectEnd !== -1 && match.index > objectEnd))
    return ctx.helpers.rangeFromOffsets(file, text, fieldMatch.index, objectStart - 1);
  return ctx.helpers.rangeFromOffsets(file, text, match.index, match.index + match[0].length);
}

/**
 * Packages that break when an app loads two copies: module-level state such as Vue's
 * provide/inject and reactivity, the active Pinia, Nuxt and Nitro app context, React's
 * dispatcher, or identity checks such as h3's error classes, Drizzle's `is()`, graphql-js
 * realm checks and Yjs constructor checks.
 */
export const DEFAULT_SINGLETONS = [
  "vue",
  "vue-router",
  "pinia",
  "nuxt",
  "nitro",
  "h3",
  "vite",
  "react",
  "react-dom",
  "drizzle-orm",
  "graphql",
  "yjs",
];

/** Default singletons plus the rule's `singletons` option; `@scope/*` matches a whole scope. */
export function singletonMatcher(options: unknown): (name: string) => boolean {
  const configured =
    isRecord(options) && Array.isArray(options.singletons)
      ? options.singletons.filter((name): name is string => typeof name === "string")
      : [];
  const names = new Set([...DEFAULT_SINGLETONS, ...configured]);
  const scopes = [...names].filter((name) => name.endsWith("/*")).map((name) => name.slice(0, -1));
  return (name) => names.has(name) || scopes.some((scope) => name.startsWith(scope));
}
