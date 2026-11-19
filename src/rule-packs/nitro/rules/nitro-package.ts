import { join, resolve } from "pathe";
import { minVersion, validRange } from "semver";
import { parse } from "yaml";
import type { RuleContext } from "../../../core/index.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import {
  detectPackageModule,
  findDefaultNuxtModuleDefinition,
} from "../../../core/internal/nuxt-module-inventory.js";
import { parseScript } from "../../../core/internal/script.js";
import { owningWorkspacePackage } from "../../../core/internal/workspace-packages.js";
import type { AnyNode } from "./shared.js";

export interface PackageManifest {
  name?: string;
  private?: boolean;
  main?: string;
  module?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface OwningPackage {
  /** Absolute package directory. */
  dir: string;
  /** The file's path inside the package. */
  path: string;
  framework: string;
  manifest: PackageManifest;
}

const RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

/** Tests, fixtures, examples and scripts run in the package's own workspace, not in a Nitro app. */
const NON_RUNTIME_DIR =
  /(?:^|\/)(?:test|tests|__tests__|__mocks__|fixtures?|examples?|playground|e2e|bench|scripts)\//;
const NON_RUNTIME_FILE =
  /(?:\.(?:test|spec|bench|test-d)\.[cm]?[jt]sx?|\.d\.[cm]?ts|\.config\.[cm]?[jt]s)$/;

export function owningPackage(ctx: RuleContext): OwningPackage | undefined {
  const relativePath = ctx.file.relativePath.replace(/\\/g, "/");
  const packages = projectWorkspacePackages(ctx.project);
  const root = owningWorkspacePackage(packages, relativePath);
  const dir = resolve(ctx.project.root, root);
  const manifest = ctx.fs.readJson(join(dir, "package.json"));
  if (!isRecord(manifest)) return undefined;
  return {
    dir,
    path: root === "." ? relativePath : relativePath.slice(root.length + 1),
    framework: packages.find((item) => item.root === root)?.framework ?? ctx.project.framework,
    manifest: manifest as PackageManifest,
  };
}

/** A file the package ships to its consumers, as opposed to its tests, examples, or config. */
export function isPackageRuntimeSource(owner: OwningPackage): boolean {
  return !NON_RUNTIME_DIR.test(owner.path) && !NON_RUNTIME_FILE.test(owner.path);
}

export function isLibrary(manifest: PackageManifest): boolean {
  return manifest.exports !== undefined || !!manifest.main || !!manifest.module;
}

/** Where the manifest declares `name`, runtime fields first. */
export function declaredIn(manifest: PackageManifest, name: string) {
  return [...RUNTIME_FIELDS, "devDependencies" as const].filter(
    (field) => typeof manifest[field]?.[name] === "string",
  );
}

export function runtimeDeclaration(manifest: PackageManifest, name: string): string | undefined {
  for (const field of RUNTIME_FIELDS) {
    const value = manifest[field]?.[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Whether a declared `nitro` range admits only Nitro 3 or later. `catalog:` ranges resolve through
 * `pnpm-workspace.yaml`; a range Doctor cannot read leaves the decision to the resolved runtime.
 */
export function declaresOnlyNitro3(ctx: RuleContext, declaration: string): boolean {
  return declaresAtLeastMajor(ctx, "nitro", declaration, 3);
}

function declaresAtLeastMajor(ctx: RuleContext, name: string, declaration: string, major: number) {
  const range = resolveCatalog(ctx, name, declaration)?.replace(/^npm:[^@]+@/, "");
  if (!range || !validRange(range)) return true;
  const lowest = minVersion(range);
  return !lowest || lowest.major >= major;
}

/**
 * Whether the package declares a runtime that excludes Nitro 2: a `nitro` range of Nitro 3 or
 * later, or, without one, a `nuxt` range of Nuxt 5 or later. Nuxt 4 runs Nitro 2.
 */
export function declaresNitro3Host(ctx: RuleContext, manifest: PackageManifest): boolean {
  if (runtimeDeclaration(manifest, "nitropack") !== undefined) return false;
  const nitro = runtimeDeclaration(manifest, "nitro");
  if (nitro !== undefined) return declaresOnlyNitro3(ctx, nitro);
  const nuxt = runtimeDeclaration(manifest, "nuxt");
  return nuxt !== undefined && declaresAtLeastMajor(ctx, "nuxt", nuxt, 5);
}

const SERVER_REGISTRATIONS = new Set([
  "addServerHandler",
  "addDevServerHandler",
  "addServerPlugin",
]);
const SCRIPT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];

/**
 * Whether `file` is server runtime that a Nuxt module package in `owner` adds to the app's Nitro:
 * a file in its module's `runtime/server` directory, or one its module entry passes to
 * `addServerHandler`, `addDevServerHandler` or `addServerPlugin` through `createResolver` or
 * `new URL(..., import.meta.url)`.
 */
export function isModuleServerRuntime(ctx: RuleContext, owner: OwningPackage): boolean {
  const entry = packageModuleEntry(ctx, owner);
  if (!entry) return false;
  const file = ctx.file.path;
  if (isInside(join(entry, "..", "runtime", "server"), file)) return true;
  return registeredServerFiles(ctx, entry).includes(file);
}

/**
 * The source file of the Nuxt module a package ships: its main entry, as Project Inventory reads
 * it, or a subpath export such as `./nuxt` whose `dist` target builds from a `src` file that
 * default-exports `defineNuxtModule`.
 */
function packageModuleEntry(ctx: RuleContext, owner: OwningPackage): string | undefined {
  const key = `nitro:package-module:${owner.dir}`;
  const cached = ctx.cache.get<string | null>(key);
  if (cached !== undefined) return cached ?? undefined;
  let entry = detectPackageModule(owner.dir)?.entry;
  const exports = owner.manifest.exports;
  if (!entry && isRecord(exports)) {
    for (const [subpath, target] of Object.entries(exports)) {
      if (subpath === "." || !subpath.startsWith("./")) continue;
      let value: unknown = target;
      while (isRecord(value)) value = value.import ?? value.default;
      const built =
        typeof value === "string" ? value.match(/^\.\/dist\/(.+)\.[cm]?js$/)?.[1] : undefined;
      const source = built && sourceFile(ctx, join(owner.dir, "src", `${built}.js`));
      const text = source && ctx.fs.readText(source);
      if (!source || !text?.includes("defineNuxtModule")) continue;
      if (!findDefaultNuxtModuleDefinition(parseScript(source, text))) continue;
      entry = source;
      break;
    }
  }
  ctx.cache.set(key, entry ?? null);
  return entry;
}

function registeredServerFiles(ctx: RuleContext, entry: string): string[] {
  const key = `nitro:module-server-files:${entry}`;
  const cached = ctx.cache.get<string[]>(key);
  if (cached) return cached;
  const text = ctx.fs.readText(entry);
  const ast = text && SERVER_REGISTRATIONS_RE.test(text) ? parseScript(entry, text) : null;
  const files: string[] = [];
  if (ast) {
    const resolvers = new Set<string>();
    const resolveFunctions = new Set<string>();
    walk(ast, (node) => {
      if (node.type === "VariableDeclarator" && isCreateResolverCall(node.init)) {
        if (node.id?.type === "Identifier") resolvers.add(node.id.name);
        for (const property of node.id?.type === "ObjectPattern" ? node.id.properties : [])
          if (property.key?.name === "resolve" && property.value?.type === "Identifier")
            resolveFunctions.add(property.value.name);
      }
    });
    const target = (node: AnyNode): string | undefined => {
      if (node?.type === "CallExpression") {
        const callee = node.callee;
        const resolverCall =
          (callee?.type === "MemberExpression" &&
            callee.object?.type === "Identifier" &&
            resolvers.has(callee.object.name) &&
            callee.property?.name === "resolve") ||
          (callee?.type === "Identifier" && resolveFunctions.has(callee.name));
        if (resolverCall) return relativeLiteral(node.arguments?.[0]);
        if (callee?.type === "Identifier" && callee.name === "fileURLToPath")
          return target(node.arguments?.[0]);
      }
      if (node?.type === "NewExpression" && node.callee?.name === "URL") {
        const base = node.arguments?.[1];
        const importMetaUrl =
          base?.type === "MemberExpression" &&
          base.object?.type === "MetaProperty" &&
          base.property?.name === "url";
        return importMetaUrl ? relativeLiteral(node.arguments?.[0]) : undefined;
      }
      return undefined;
    };
    walk(ast, (node) => {
      if (node.type !== "CallExpression" || !SERVER_REGISTRATIONS.has(node.callee?.name)) return;
      const argument = node.arguments?.[0];
      const value =
        node.callee.name === "addServerPlugin"
          ? argument
          : argument?.type === "ObjectExpression"
            ? argument.properties?.find((property: AnyNode) => property.key?.name === "handler")
                ?.value
            : undefined;
      const path = value && target(value);
      const file = path && sourceFile(ctx, resolve(entry, "..", path));
      if (file) files.push(file);
    });
  }
  ctx.cache.set(key, files);
  return files;
}

const SERVER_REGISTRATIONS_RE = /\badd(?:Dev)?Server(?:Handler|Plugin)\b/;

function isCreateResolverCall(node: AnyNode): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "createResolver"
  );
}

function relativeLiteral(node: AnyNode): string | undefined {
  const value =
    node?.type === "Literal" || node?.type === "StringLiteral"
      ? node.value
      : node?.type === "TemplateLiteral" && !node.expressions?.length
        ? node.quasis?.[0]?.value?.cooked
        : undefined;
  return typeof value === "string" && value.startsWith(".") ? value : undefined;
}

/** The source file a registered path names; the module builder emits `.js` for `.ts` sources. */
function sourceFile(ctx: RuleContext, path: string): string | undefined {
  const base = path.replace(/\.[cm]?js$/, "");
  const candidates = [
    path,
    ...SCRIPT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SCRIPT_EXTENSIONS.map((extension) => join(path, `index${extension}`)),
  ];
  return candidates.find((candidate) => ctx.fs.stat(candidate)?.isFile());
}

function walk(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node))
    if (key !== "parent" && value && typeof value === "object") walk(value, visit);
}

function isInside(dir: string, file: string) {
  return file.startsWith(`${dir}/`);
}

function resolveCatalog(ctx: RuleContext, name: string, declaration: string) {
  if (!declaration.startsWith("catalog:")) return declaration;
  const workspace = ctx.cache.get<unknown>("nitro:pnpm-workspace") ?? readWorkspace(ctx);
  const catalogName = declaration.slice("catalog:".length) || "default";
  const catalogs = isRecord(workspace) && isRecord(workspace.catalogs) ? workspace.catalogs : {};
  const catalog =
    catalogName === "default" && isRecord(workspace) && isRecord(workspace.catalog)
      ? workspace.catalog
      : catalogs[catalogName];
  const value = isRecord(catalog) ? catalog[name] : undefined;
  return typeof value === "string" ? value : undefined;
}

function readWorkspace(ctx: RuleContext): unknown {
  const text = ctx.fs.readText(join(ctx.project.root, "pnpm-workspace.yaml"));
  let value: unknown = null;
  try {
    value = text === undefined ? null : parse(text);
  } catch {
    value = null;
  }
  ctx.cache.set("nitro:pnpm-workspace", value);
  return value;
}

export interface NitroH3Exports {
  /** Names `nitro/h3` exports at runtime. */
  names: Set<string>;
  /** `nitro/h3` re-exports every name of an h3 package, so namespaces and types carry over. */
  reexportsH3: boolean;
}

/**
 * The runtime exports of `nitro/h3` in the Nitro installed for `dir`, read from the installed
 * files. `undefined` when Nitro is not installed or its `h3` entry cannot be read statically.
 */
export function installedNitroH3Exports(ctx: RuleContext, dir: string): NitroH3Exports | undefined {
  const key = `nitro:h3-exports:${dir}`;
  const cached = ctx.cache.get<NitroH3Exports | null>(key);
  if (cached !== undefined) return cached ?? undefined;
  const nitro = resolvePackage(ctx, "nitro", dir);
  const entry = nitro && packageEntry(nitro.manifest, "./h3");
  const result = nitro && entry ? moduleExports(ctx, join(nitro.dir, entry), 0) : undefined;
  const value =
    result && result.names.size
      ? { names: result.names, reexportsH3: result.starSources.has("h3") }
      : undefined;
  ctx.cache.set(key, value ?? null);
  return value;
}

interface ModuleExports {
  names: Set<string>;
  /** Bare package names re-exported with `export *`. */
  starSources: Set<string>;
}

function moduleExports(ctx: RuleContext, file: string, depth: number): ModuleExports | undefined {
  const text = ctx.fs.readText(file);
  const ast = text === undefined ? null : parseScript(file, text);
  if (!ast || depth > 3) return undefined;
  const names = new Set<string>();
  const starSources = new Set<string>();
  for (const statement of (ast.body ?? []) as AnyNode[]) {
    if (statement.type === "ExportDefaultDeclaration") names.add("default");
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.exportKind === "type") continue;
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.exportKind === "type") continue;
        const exported = specifier.exported?.name ?? specifier.exported?.value;
        if (typeof exported === "string") names.add(exported);
      }
      for (const name of declarationNames(statement.declaration)) names.add(name);
    }
    if (statement.type !== "ExportAllDeclaration" || statement.exportKind === "type") continue;
    const source = statement.source?.value;
    if (typeof source !== "string") return undefined;
    if (statement.exported) {
      const exported = statement.exported.name ?? statement.exported.value;
      if (typeof exported === "string") names.add(exported);
      continue;
    }
    let target: string | undefined;
    if (source.startsWith(".")) target = resolve(file, "..", source);
    else {
      const pkg = resolvePackage(ctx, source, resolve(file, ".."));
      const entry = pkg && packageEntry(pkg.manifest, ".");
      target = pkg && entry ? join(pkg.dir, entry) : undefined;
      if (target) starSources.add(source);
    }
    const nested = target ? moduleExports(ctx, target, depth + 1) : undefined;
    if (!nested) return undefined;
    for (const name of nested.names) if (name !== "default") names.add(name);
    for (const name of nested.starSources) starSources.add(name);
  }
  return { names, starSources };
}

function declarationNames(declaration: AnyNode): string[] {
  if (!declaration) return [];
  if (declaration.id?.name) return [declaration.id.name];
  return (declaration.declarations ?? []).flatMap((item: AnyNode) =>
    item.id?.type === "Identifier" ? [item.id.name] : [],
  );
}

/** Node resolution of `name/package.json` from `from`, through the run's tracked file system. */
function resolvePackage(ctx: RuleContext, name: string, from: string) {
  let dir = ctx.fs.realpath(from) ?? from;
  for (;;) {
    if (!dir.endsWith("/node_modules")) {
      const candidate = join(dir, "node_modules", name);
      const manifest = ctx.fs.readJson(join(candidate, "package.json"));
      if (isRecord(manifest)) return { dir: ctx.fs.realpath(candidate) ?? candidate, manifest };
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function packageEntry(manifest: Record<string, unknown>, subpath: string): string | undefined {
  const exports = manifest.exports;
  let target: unknown =
    isRecord(exports) && Object.keys(exports).some((key) => key.startsWith("."))
      ? exports[subpath]
      : subpath === "."
        ? (exports ?? manifest.module ?? manifest.main)
        : undefined;
  while (isRecord(target)) target = target.default ?? target.import ?? target.node;
  return typeof target === "string" ? target : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An import or re-export that loads no runtime value: `import type`, or only `type` specifiers. */
export function isTypeOnlyModuleReference(node: AnyNode): boolean {
  if ((node.importKind ?? node.exportKind) === "type") return true;
  if (node.type === "ExportAllDeclaration") return false;
  const specifiers: AnyNode[] = node.specifiers ?? [];
  // `export {} from "h3"` and `import "h3"` still load the module.
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => (specifier.importKind ?? specifier.exportKind) === "type")
  );
}
