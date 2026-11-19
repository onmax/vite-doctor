import { dirname, relative, resolve } from "pathe";
import { valid } from "semver";
import { parse } from "yaml";
import type { Expression, JsonSourceFile } from "typescript";
import { loadTypeScript } from "../../core/internal/lazy-parsers.js";
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
  let root = project.root;
  for (let directory = project.root; ; directory = dirname(directory)) {
    if (ctx.fs.exists(resolve(directory, "pnpm-workspace.yaml"))) {
      root = directory;
      break;
    }
    if (dirname(directory) === directory) break;
  }
  const roots = new Set((project.workspacePackages ?? [{ root: "." }]).map((item) => item.root));
  const workspaceText = ctx.fs.readText(resolve(root, "pnpm-workspace.yaml"));
  const config: unknown = workspaceText === undefined ? undefined : parse(workspaceText);
  if (isRecord(config) && Array.isArray(config.packages)) {
    const patterns = config.packages.filter(
      (pattern): pattern is string => typeof pattern === "string",
    );
    const exclude = [
      "**/node_modules/**",
      ...patterns
        .filter((pattern) => pattern.startsWith("!"))
        .map((pattern) => `${pattern.slice(1)}/package.json`),
    ];
    for (const pattern of patterns.filter((pattern) => !pattern.startsWith("!"))) {
      for (const file of ctx.fs.glob(`${pattern}/package.json`, { cwd: root, exclude })) {
        roots.add(relative(project.root, dirname(file)) || ".");
      }
    }
  }
  const packages = [...roots].flatMap((packageRoot) => {
    const file = resolve(project.root, packageRoot, "package.json");
    const text = ctx.fs.readText(file);
    if (text === undefined) return [];
    return [{ root: packageRoot, file, text, manifest: parsePackageManifest(JSON.parse(text)) }];
  });
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
  alias?: string;
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
        ...resolved,
        catalog: catalog === "default" ? "catalog" : `catalogs.${catalog}`,
      }
    );
  }
  if (specifier.startsWith("npm:")) {
    const at = specifier.lastIndexOf("@");
    return at > "npm:".length
      ? { range: specifier.slice(at + 1), alias: specifier.slice(0, at + 1) }
      : undefined;
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
  return (
    manifestPropertyRange(ctx, file, text, [field, name]) ??
    ctx.helpers.rangeFromOffsets(file, text, 0, 0)
  );
}

export function manifestPropertyRange(
  ctx: RuleContext,
  file: string,
  text: string,
  path: string[],
): SourceRange | undefined {
  const ts = loadTypeScript();
  const key = `package:manifest-source:${file}`;
  let source = ctx.cache.get<JsonSourceFile>(key);
  if (!source) {
    source = ts.parseJsonText(file, text);
    ctx.cache.set(key, source);
  }
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return;
  let value: Expression = statement.expression;
  for (const [index, name] of path.entries()) {
    if (!ts.isObjectLiteralExpression(value)) return;
    const property = value.properties.findLast(
      (member) =>
        ts.isPropertyAssignment(member) &&
        ts.isStringLiteral(member.name) &&
        member.name.text === name,
    );
    if (!property || !ts.isPropertyAssignment(property)) return;
    if (index === path.length - 1)
      return ctx.helpers.rangeFromOffsets(file, text, property.getStart(source), property.end);
    value = property.initializer;
  }
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

/** Context may include siblings, but diagnostics stay inside the requested run. */
export function inRunScope(item: WorkspaceManifest): boolean {
  return item.root !== ".." && !item.root.startsWith("../");
}
