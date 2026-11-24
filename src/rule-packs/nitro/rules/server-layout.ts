import mime from "mime";
import { parseSync } from "oxc-parser";
import { isAbsolute, relative, resolve } from "pathe";
import type { ProjectInfo, RuleContext, RuleFileSystem } from "../../../core/index.js";

export interface StaticConfigOption {
  path: string[];
  value: string | boolean | null;
  strings?: string[];
  routes?: { handler: string; method: string }[];
}

export interface NitroServerFile {
  serverDir: string;
  path: string;
  dir: string;
}

const NITRO_CONFIG_FILES = configFiles("nitro.config");
const VITE_CONFIG_FILES = configFiles("vite.config");
const NUXT_CONFIG_FILES = configFiles("nuxt.config");
const ROUTE_DIRS = new Set(["api", "routes"]);
const SCANNED_SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const TEST_DIRECTORY = /(?:^|\/)(?:tests?|__tests__)\//;
const SCAN_IGNORE_OPTIONS = new Set(["ignore", "ignorePrefix", "ignoreOptions"]);
const NITRO3_METHODS = new Set([
  "connect",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "query",
  "trace",
]);
const NITRO3_ENVS = new Set(["dev", "prod", "prerender"]);
const LAST_SUFFIX = /(?<=[^/])\.([a-z]+)$/;
const ORDER_PREFIX = /(?:^|\/)\d+$/;

export function nitroServerDirs(ctx: RuleContext): string[] {
  const key = "nitro:server-dirs";
  let dirs = ctx.cache.get<string[]>(key);
  if (!dirs) {
    dirs = resolveServerDirs(ctx);
    ctx.cache.set(key, dirs);
  }
  return dirs;
}

export function nitroServerFile(ctx: RuleContext, file: string): NitroServerFile | null {
  let match: NitroServerFile | null = null;
  for (const serverDir of nitroServerDirs(ctx)) {
    const path = relative(serverDir, file);
    if (!path || path.startsWith("../") || isAbsolute(path)) continue;
    if (match && match.serverDir.length >= serverDir.length) continue;
    match = { serverDir, path, dir: path.split("/")[0]! };
  }
  return match;
}

/** A file under a Nitro server directory that runs in the server bundle: not a test, type declaration, or config. */
export function isNitroRuntimeFile(ctx: RuleContext) {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  if (TEST_DIRECTORY.test(path) || TEST_FILE.test(path) || DECLARATION_FILE.test(path))
    return false;
  return Boolean(nitroServerFile(ctx, ctx.file.path)) && !/\.config\.[cm]?[jt]s$/.test(path);
}

export function nitroRouteFile(ctx: RuleContext, file: string): NitroServerFile | null {
  return nitroScannedFile(ctx, file, ROUTE_DIRS);
}

/**
 * The server file when Nitro's scan of one of `dirs` provably picks it up: default scan layout,
 * a scanned script extension, and not dropped by Nuxt's or Nitro's default ignore patterns.
 */
export function nitroScannedFile(
  ctx: RuleContext,
  file: string,
  dirs: ReadonlySet<string>,
): NitroServerFile | null {
  const project = ctx.project;
  const options = readStaticConfigOptions(ctx, project.framework === "nuxt" ? "nuxt" : "nitro");
  if (
    options.some(
      ({ path }) =>
        path.length === 0 ||
        ["scanDirs", "apiDir", "routesDir", "middlewareDir"].includes(path.at(-1)!),
    )
  )
    return null;
  const serverFile = nitroServerFile(ctx, file);
  if (!serverFile || !dirs.has(serverFile.dir) || !serverFile.path.includes("/")) return null;
  if (!isNitroScannedScript(ctx, serverFile.path)) return null;
  if (
    (runtimeMajor(project, "nitro") ?? 2) >= 3 &&
    !nitro3ScanPath(
      ctx,
      serverFile.path.slice(serverFile.dir.length + 1),
      ROUTE_DIRS.has(serverFile.dir),
    )
  )
    return null;
  return serverFile;
}

export function nitro3ScanPath(ctx: RuleContext, path: string, route: boolean) {
  const { name, method, env } = nitro3PathParts(path, route);
  const suffix = name.match(LAST_SUFFIX)?.[1];
  if (suffix) {
    const reserved = NITRO3_METHODS.has(suffix) || NITRO3_ENVS.has(suffix);
    if (
      !(route && reserved) &&
      !mime.getType(suffix) &&
      !(!reserved && ORDER_PREFIX.test(name.slice(0, -suffix.length - 1))) &&
      !hasStaticScanSuffix(ctx, suffix)
    )
      return undefined;
  }
  return { name, method, env };
}

export function nitro3DefaultHandlerMayUseCache(ctx: RuleContext, file: NitroServerFile): boolean {
  const options = readStaticConfigOptions(ctx, ctx.project.framework === "nuxt" ? "nuxt" : "nitro");
  const filename = resolve(file.serverDir, file.path);
  const routeOptions = options.filter(({ path }) => path.at(-1) === "routes");
  let uncertain = options.some(({ path }) => path.at(-1) === "handlers");
  let bypassesCache = false;
  for (const { routes } of routeOptions) {
    if (!routes) {
      uncertain = true;
      continue;
    }
    for (const { handler, method } of routes) {
      if (resolve(ctx.project.root, handler) !== filename) continue;
      if (nitro3CacheableMethod(method)) return true;
      bypassesCache = true;
    }
  }
  if (options.some(({ path }) => path.at(-1) === "scanDirs")) return false;
  for (const dir of ROUTE_DIRS) {
    const overrides = options.filter(({ path }) => path.at(-1) === `${dir}Dir`);
    const roots = overrides.length
      ? new Set(
          overrides.map(({ value }) =>
            typeof value === "string" || value === false
              ? resolve(file.serverDir, value || dir)
              : undefined,
          ),
        )
      : new Set([resolve(file.serverDir, dir)]);
    const [root] = roots;
    if (roots.size !== 1 || root === undefined) {
      uncertain = true;
      continue;
    }
    const path = relative(root, filename);
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) continue;
    if (!isNitroScannedScript(ctx, path)) continue;
    const { method } = nitro3PathParts(path, true);
    if (nitro3CacheableMethod(method)) {
      if (nitro3ScanPath(ctx, path, true)) return true;
    } else {
      bypassesCache = true;
    }
  }
  return !bypassesCache && !uncertain;
}

function nitro3CacheableMethod(method: string | undefined): boolean {
  return !method || method === "get" || method === "head";
}

function nitro3PathParts(path: string, route: boolean) {
  let name = path.replace(SCANNED_SCRIPT, "");
  let env: string | undefined;
  let method: string | undefined;
  if (route) {
    const envSuffix = name.match(LAST_SUFFIX)?.[1];
    if (envSuffix && NITRO3_ENVS.has(envSuffix)) {
      env = envSuffix;
      name = name.slice(0, -env.length - 1);
    }
    const methodSuffix = name.match(LAST_SUFFIX)?.[1];
    if (methodSuffix && NITRO3_METHODS.has(methodSuffix)) {
      method = methodSuffix;
      name = name.slice(0, -method.length - 1);
    }
  }
  return { name, method, env };
}

function hasStaticScanSuffix(ctx: RuleContext, suffix: string): boolean {
  const nuxt = ctx.project.framework === "nuxt";
  const options = readStaticConfigOptions(ctx, nuxt ? "nuxt" : "nitro");
  const configured = options.filter(({ path }) =>
    nuxt ? path.join(".") === "nitro.scanSuffixes" : path.at(-1) === "scanSuffixes",
  );
  return (
    configured.length === 1 &&
    configured[0]?.strings?.includes(suffix) === true &&
    !hasUnresolvedNitroConfig(ctx, options)
  );
}

/** Whether Nitro's directory scan keeps this server-relative path under default ignore patterns. */
export function isNitroScannedScript(ctx: RuleContext, path: string): boolean {
  if (!SCANNED_SCRIPT.test(path) || DECLARATION_FILE.test(path)) return false;
  if (ctx.project.framework === "nuxt") return !isIgnoredByNuxtDefaults(path);
  // Nitro 3 adds test and spec files to its scan ignore list; Nitro 2 scans them.
  return (runtimeMajor(ctx.project, "nitro") ?? 2) < 3 || !TEST_FILE.test(path);
}

/** Custom ignore patterns can drop any scanned file, so the scan result is not provable. */
export function hasCustomScanIgnore(ctx: RuleContext): boolean {
  const nuxt = ctx.project.framework === "nuxt";
  const options = readStaticConfigOptions(ctx, nuxt ? "nuxt" : "nitro");
  if (
    hasUnresolvedNitroConfig(ctx, options) ||
    options.some(({ path }) => SCAN_IGNORE_OPTIONS.has(path.at(-1)!))
  )
    return true;
  return nuxt && ctx.fs.exists(resolve(ctx.project.root, ".nuxtignore"));
}

export function hasUnresolvedNitroConfig(ctx: RuleContext, options: StaticConfigOption[]): boolean {
  if (
    options.some(
      ({ path }) => path.length === 0 || path.at(-1) === "extends" || path.at(-1)?.startsWith("$"),
    )
  )
    return true;
  if (ctx.project.framework !== "nuxt") return false;
  if ((ctx.project.nuxt?.layers.length ?? 0) > 1) return true;
  return (ctx.fs.readDir(resolve(ctx.project.root, "layers")) ?? []).some(
    (entry) => entry.isDirectory() || entry.isSymbolicLink(),
  );
}

export function readStaticConfigOptions(
  ctx: RuleContext,
  kind: "nitro" | "nuxt",
): StaticConfigOption[] {
  const key = `nitro:static-config-options:${kind}`;
  let options = ctx.cache.get<StaticConfigOption[]>(key);
  if (!options) {
    const files =
      kind === "nuxt" ? NUXT_CONFIG_FILES : [...NITRO_CONFIG_FILES, ...VITE_CONFIG_FILES];
    options = files.flatMap((file) => configOptions(ctx.fs, resolve(ctx.project.root, file)));
    ctx.cache.set(key, options);
  }
  return options;
}

export function staticOptionValue(
  options: StaticConfigOption[],
  matches: (path: string[]) => boolean,
): string | boolean | null | undefined {
  return options.findLast((option) => matches(option.path))?.value;
}

export function runtimeMajor(project: ProjectInfo, runtime: "nitro" | "nuxt"): number | undefined {
  const version = project.runtimeGraph?.packages[runtime]?.version;
  const major = version ? Number.parseInt(version, 10) : Number.NaN;
  if (Number.isFinite(major)) return major;
  if (runtime === "nuxt") {
    const declared = Number.parseInt(project.nuxtVersion ?? "", 10);
    return Number.isFinite(declared) ? declared : undefined;
  }
  const packages = (project.inventory?.packages ?? {}) as Record<string, unknown>;
  if (packages.nitro) return 3;
  if (packages.nitropack) return 2;
  return undefined;
}

function resolveServerDirs(ctx: RuleContext): string[] {
  const project = ctx.project;
  const options = readStaticConfigOptions(ctx, project.framework === "nuxt" ? "nuxt" : "nitro");
  if (options.some(({ path }) => path.length === 0)) return [];
  if (project.framework === "nuxt") return nuxtServerDirs(ctx);
  if (project.framework === "nitro") return standaloneNitroServerDirs(ctx);
  return [];
}

function nuxtServerDirs(ctx: RuleContext): string[] {
  const project = ctx.project;
  const root = project.root;
  const nuxt = project.nuxt;
  const layerDirs =
    nuxt?.manifest?.isCurrent && nuxt.manifestPath
      ? nuxt.layers.flatMap((layer) => (layer.serverDir ? [resolve(root, layer.serverDir)] : []))
      : [];
  if (layerDirs.length) return [...new Set(layerDirs)];
  const options = readStaticConfigOptions(ctx, "nuxt");
  const serverDir = staticOptionValue(options, (path) => path.join(".") === "serverDir");
  if (typeof serverDir === "string") return [resolve(root, serverDir)];
  if (serverDir === null) return [];
  if ((runtimeMajor(project, "nuxt") ?? 4) >= 4) return [resolve(root, "server")];
  // Nuxt 3 resolves serverDir from srcDir, which also defaults to the root.
  const srcDir = staticOptionValue(options, (path) => path.join(".") === "srcDir");
  if (typeof srcDir === "string") return [resolve(root, srcDir, "server")];
  return [resolve(root, "server"), resolve(root, "app/server")];
}

function standaloneNitroServerDirs(ctx: RuleContext): string[] {
  const project = ctx.project;
  const root = project.root;
  const options = readStaticConfigOptions(ctx, "nitro");
  const serverDir = staticOptionValue(
    options,
    (path) => path.at(-1) === "serverDir" && path.at(-2) !== "output",
  );
  const srcDir = staticOptionValue(options, (path) => path.at(-1) === "srcDir");
  if ((runtimeMajor(project, "nitro") ?? 2) >= 3) {
    // Nitro 3 scans nothing unless serverDir (or the deprecated srcDir alias) is set.
    const dir = serverDir === undefined ? srcDir : serverDir;
    if (dir === true) return [resolve(root, "server")];
    return typeof dir === "string" ? [resolve(root, dir || ".")] : [];
  }
  if (srcDir === undefined) return [root];
  return typeof srcDir === "string" ? [resolve(root, srcDir || ".")] : [];
}

function isIgnoredByNuxtDefaults(path: string) {
  const name = path.split("/").at(-1)!;
  return name.startsWith("-") || /\.stories\.[cm]?[jt]sx?$/.test(name) || TEST_FILE.test(name);
}

function configFiles(base: string) {
  return ["ts", "mts", "cts", "js", "mjs", "cjs"].map((extension) => `${base}.${extension}`);
}

function configOptions(fs: RuleFileSystem, file: string): StaticConfigOption[] {
  const text = fs.readText(file);
  if (text === undefined) return [];
  let program: unknown;
  try {
    const parsed = parseSync(file, text, { sourceType: "module", lang: "ts" });
    if (parsed.errors.length) return [{ path: [], value: null }];
    program = parsed.program;
  } catch {
    return [{ path: [], value: null }];
  }
  if (file.includes("vite.config.")) return viteConfigOptions(program);
  const options: StaticConfigOption[] = [];
  const expression = (program as any).body.find(
    (statement: any) => statement.type === "ExportDefaultDeclaration",
  )?.declaration;
  const config = unwrapConfig(expression);
  if (!config) return [{ path: [], value: null }];
  collectOptions(config, [], options);
  return options;
}

function viteConfigOptions(program: any): StaticConfigOption[] {
  const config = viteNitroConfig(program);
  if (!config) return [];
  const { properties, pluginsProperty, pluginNames, namespaceNames } = config;
  const nitroProperty = properties.findLast(
    (property: any) => vitePropertyKey(property) === "nitro",
  );
  const options: StaticConfigOption[] = [];
  for (const property of properties) {
    const key = vitePropertyKey(property);
    if (key === "nitro" && property === nitroProperty) {
      const nested = unwrapConfig(property.value);
      if (nested) collectOptions(nested, ["nitro"], options);
      else options.push({ path: [], value: null });
    }
    if (key !== "plugins" || property !== pluginsProperty) continue;
    collectNitroPluginOptions(property.value, pluginNames, namespaceNames, options);
  }
  const earliestConfig = Math.min(
    properties.indexOf(nitroProperty),
    properties.indexOf(pluginsProperty),
  );
  if (
    properties.slice(earliestConfig + 1).some((property: any) => vitePropertyKey(property) === null)
  )
    options.push({ path: ["nitro", "scanSuffixes"], value: null });
  return options;
}

function vitePropertyKey(property: any): string | null {
  if (property.type !== "Property") return null;
  if (property.computed && property.key.type !== "Literal") return null;
  return propertyKey(property.key);
}

export function hasViteNitroPlugin(program: Record<string, unknown>): boolean {
  return viteNitroConfig(program) !== undefined;
}

function viteNitroConfig(program: any) {
  const pluginNames = new Set<string>();
  const namespaceNames = new Set<string>();
  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== "nitro/vite" ||
      statement.importKind === "type"
    )
      continue;
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        propertyKey(specifier.imported) === "nitro"
      )
        pluginNames.add(specifier.local.name);
      if (specifier.type === "ImportNamespaceSpecifier") namespaceNames.add(specifier.local.name);
    }
  }
  const expression = program.body.find(
    (statement: any) => statement.type === "ExportDefaultDeclaration",
  )?.declaration;
  const config = unwrapConfig(expression);
  if (!config) return undefined;
  const pluginsProperty = config.properties.findLast(
    (property: any) => vitePropertyKey(property) === "plugins",
  );
  const plugins = pluginsProperty?.value;
  if (!hasNitroPlugin(plugins, pluginNames, namespaceNames)) return undefined;
  return { properties: config.properties, pluginsProperty, pluginNames, namespaceNames };
}

function hasNitroPlugin(node: any, names: Set<string>, namespaces: Set<string>): boolean {
  if (!node) return false;
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression")
    return hasNitroPlugin(node.expression, names, namespaces);
  if (node.type === "ArrayExpression")
    return node.elements.some((element: any) => hasNitroPlugin(element, names, namespaces));
  if (node.type !== "CallExpression") return false;
  return isNitroPluginCallee(node.callee, names, namespaces);
}

function collectNitroPluginOptions(
  node: any,
  names: Set<string>,
  namespaces: Set<string>,
  options: StaticConfigOption[],
) {
  if (!node) return;
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    collectNitroPluginOptions(node.expression, names, namespaces, options);
    return;
  }
  if (node.type === "ArrayExpression") {
    for (const element of node.elements)
      collectNitroPluginOptions(element, names, namespaces, options);
    return;
  }
  if (node.type !== "CallExpression" || !isNitroPluginCallee(node.callee, names, namespaces))
    return;
  const nested =
    node.arguments.length === 1
      ? unwrapConfig(node.arguments[0])
      : node.arguments.length === 0
        ? { type: "ObjectExpression", properties: [] }
        : undefined;
  if (nested) collectOptions(nested, ["nitro"], options);
  else options.push({ path: [], value: null });
}

function isNitroPluginCallee(node: any, names: Set<string>, namespaces: Set<string>): boolean {
  if (node?.type === "Identifier") return names.has(node.name);
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    namespaces.has(node.object.name) &&
    propertyKey(node.property) === "nitro"
  );
}

function unwrapConfig(node: any): any {
  while (node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression")
    node = node.expression;
  if (
    node?.type === "CallExpression" &&
    ["defineConfig", "defineNitroConfig", "defineNuxtConfig"].includes(node.callee?.name) &&
    node.arguments.length === 1
  )
    return unwrapConfig(node.arguments[0]);
  return node?.type === "ObjectExpression" ? node : undefined;
}

function collectOptions(node: any, path: string[], options: StaticConfigOption[]) {
  if (node?.type !== "ObjectExpression") return;
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed) {
      options.push({ path: [], value: null });
      continue;
    }
    const key = propertyKey(property.key);
    if (!key) continue;
    if (key === "extends" || key.startsWith("$")) {
      options.push({ path: [...path, key], value: null });
      continue;
    }
    if (key === "imports" || key === "experimental") {
      const nested = unwrapConfig(property.value);
      if (nested) {
        for (const option of nested.properties) {
          if (option.type !== "Property" || option.computed) continue;
          const name = propertyKey(option.key);
          if (name === (key === "imports" ? "autoImport" : "nitroAutoImports"))
            options.push({ path: [...path, key, name], value: literalValue(option.value) });
        }
      }
    }
    if (
      ![
        "srcDir",
        "serverDir",
        "scanDirs",
        "apiDir",
        "routesDir",
        "routes",
        "handlers",
        "middlewareDir",
        "scanSuffixes",
        "nitro",
        "imports",
        "cache",
        "ignore",
        "ignorePrefix",
        "ignoreOptions",
      ].includes(key)
    )
      continue;
    const next = [...path, key];
    const option: StaticConfigOption = { path: next, value: literalValue(property.value) };
    if (key === "scanSuffixes" && property.kind === "init") {
      const strings = literalStringArray(property.value);
      if (strings) option.strings = strings;
    }
    if (key === "routes" && property.kind === "init") {
      const routes = staticRoutes(property.value);
      if (routes) option.routes = routes;
    }
    options.push(option);
    if (key === "nitro") {
      const nested = unwrapConfig(property.value);
      if (nested) collectOptions(nested, next, options);
      else options.push({ path: [], value: null });
    }
  }
}

function staticRoutes(node: any): StaticConfigOption["routes"] {
  const config = unwrapConfig(node);
  if (!config) return undefined;
  const routes = new Map<string, NonNullable<StaticConfigOption["routes"]>[number]>();
  for (const route of config.properties) {
    const key = vitePropertyKey(route);
    if (key === null || route.kind !== "init") return undefined;
    const options = unwrapConfig(route.value);
    if (options?.properties.some((property: any) => vitePropertyKey(property) === null))
      return undefined;
    const handler = literalValue(
      options
        ? options.properties.findLast((property: any) => vitePropertyKey(property) === "handler")
            ?.value
        : route.value,
    );
    const methodOption = options?.properties.findLast(
      (property: any) => vitePropertyKey(property) === "method",
    );
    const method = methodOption ? literalValue(methodOption.value) : "";
    if (
      typeof handler !== "string" ||
      (!handler.startsWith("./") && !isAbsolute(handler)) ||
      typeof method !== "string"
    )
      return undefined;
    routes.set(key, { handler, method: method.toLowerCase() });
  }
  return [...routes.values()];
}

function propertyKey(node: any): string | null {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function literalValue(node: any): string | boolean | null {
  while (node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression")
    node = node.expression;
  if (
    node?.type === "Literal" &&
    (typeof node.value === "string" || typeof node.value === "boolean")
  )
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value?.cooked ?? null;
  return null;
}

function literalStringArray(node: any): string[] | undefined {
  while (node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression")
    node = node.expression;
  if (node?.type !== "ArrayExpression") return undefined;
  const values: string[] = [];
  for (const element of node.elements) {
    const value = literalValue(element);
    if (typeof value !== "string") return undefined;
    values.push(value);
  }
  return values;
}
