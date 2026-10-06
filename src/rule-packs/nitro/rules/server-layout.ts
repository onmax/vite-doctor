import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { isAbsolute, relative, resolve } from "pathe";
import type { ProjectInfo } from "../../../core/index.js";

export interface StaticConfigOption {
  path: string[];
  value: string | boolean | null;
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

const serverDirsCache = new WeakMap<ProjectInfo, string[]>();
const configCache = new WeakMap<ProjectInfo, Map<string, StaticConfigOption[]>>();

export function nitroServerDirs(project: ProjectInfo): string[] {
  let dirs = serverDirsCache.get(project);
  if (!dirs) {
    dirs = resolveServerDirs(project);
    serverDirsCache.set(project, dirs);
  }
  return dirs;
}

export function nitroServerFile(project: ProjectInfo, file: string): NitroServerFile | null {
  let match: NitroServerFile | null = null;
  for (const serverDir of nitroServerDirs(project)) {
    const path = relative(serverDir, file);
    if (!path || path.startsWith("../") || isAbsolute(path)) continue;
    if (match && match.serverDir.length >= serverDir.length) continue;
    match = { serverDir, path, dir: path.split("/")[0]! };
  }
  return match;
}

export function nitroRouteFile(project: ProjectInfo, file: string): NitroServerFile | null {
  const options = readStaticConfigOptions(project, project.framework === "nuxt" ? "nuxt" : "nitro");
  if (
    options.some(
      ({ path }) => path.length === 0 || ["scanDirs", "apiDir", "routesDir"].includes(path.at(-1)!),
    )
  )
    return null;
  const serverFile = nitroServerFile(project, file);
  if (!serverFile || !ROUTE_DIRS.has(serverFile.dir) || !serverFile.path.includes("/")) return null;
  if (!SCANNED_SCRIPT.test(file) || DECLARATION_FILE.test(file)) return null;
  if (project.framework === "nuxt" && isIgnoredByNuxtDefaults(serverFile.path)) return null;
  return serverFile;
}

export function readStaticConfigOptions(
  project: ProjectInfo,
  kind: "nitro" | "nuxt",
): StaticConfigOption[] {
  let cache = configCache.get(project);
  if (!cache) {
    cache = new Map();
    configCache.set(project, cache);
  }
  let options = cache.get(kind);
  if (!options) {
    const files =
      kind === "nuxt" ? NUXT_CONFIG_FILES : [...NITRO_CONFIG_FILES, ...VITE_CONFIG_FILES];
    options = files.flatMap((file) => configOptions(resolve(project.root, file)));
    cache.set(kind, options);
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

function resolveServerDirs(project: ProjectInfo): string[] {
  const options = readStaticConfigOptions(project, project.framework === "nuxt" ? "nuxt" : "nitro");
  if (options.some(({ path }) => path.length === 0)) return [];
  if (project.framework === "nuxt") return nuxtServerDirs(project);
  if (project.framework === "nitro") return standaloneNitroServerDirs(project);
  return [];
}

function nuxtServerDirs(project: ProjectInfo): string[] {
  const root = project.root;
  const nuxt = project.nuxt;
  const layerDirs =
    nuxt?.manifest?.isCurrent && nuxt.manifestPath
      ? nuxt.layers.flatMap((layer) => (layer.serverDir ? [resolve(root, layer.serverDir)] : []))
      : [];
  if (layerDirs.length) return [...new Set(layerDirs)];
  const options = readStaticConfigOptions(project, "nuxt");
  const serverDir = staticOptionValue(options, (path) => path.join(".") === "serverDir");
  if (typeof serverDir === "string") return [resolve(root, serverDir)];
  if (serverDir === null) return [];
  if ((runtimeMajor(project, "nuxt") ?? 4) >= 4) return [resolve(root, "server")];
  // Nuxt 3 resolves serverDir from srcDir, which also defaults to the root.
  const srcDir = staticOptionValue(options, (path) => path.join(".") === "srcDir");
  if (typeof srcDir === "string") return [resolve(root, srcDir, "server")];
  return [resolve(root, "server"), resolve(root, "app/server")];
}

function standaloneNitroServerDirs(project: ProjectInfo): string[] {
  const root = project.root;
  const options = readStaticConfigOptions(project, "nitro");
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
  return (
    name.startsWith("-") ||
    /\.stories\.[cm]?[jt]sx?$/.test(name) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(name)
  );
}

function configFiles(base: string) {
  return ["ts", "mts", "cts", "js", "mjs", "cjs"].map((extension) => `${base}.${extension}`);
}

function configOptions(file: string): StaticConfigOption[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
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
  const pluginNames = new Set<string>();
  const namespaceNames = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "nitro/vite") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && propertyKey(specifier.imported) === "nitro")
        pluginNames.add(specifier.local.name);
      if (specifier.type === "ImportNamespaceSpecifier") namespaceNames.add(specifier.local.name);
    }
  }
  const expression = program.body.find(
    (statement: any) => statement.type === "ExportDefaultDeclaration",
  )?.declaration;
  const config = unwrapConfig(expression);
  if (!config) return [];
  const pluginsProperty = config.properties.findLast(
    (property: any) =>
      property.type === "Property" && !property.computed && propertyKey(property.key) === "plugins",
  );
  const plugins = pluginsProperty?.value;
  if (!hasNitroPlugin(plugins, pluginNames, namespaceNames)) return [];
  const nitroProperty = config.properties.findLast(
    (property: any) =>
      property.type === "Property" && !property.computed && propertyKey(property.key) === "nitro",
  );
  const options: StaticConfigOption[] = [];
  for (const property of config.properties) {
    if (property.type !== "Property" || property.computed) continue;
    const key = propertyKey(property.key);
    if (key === "nitro" && property === nitroProperty) {
      const nested = unwrapConfig(property.value);
      if (nested) collectOptions(nested, ["nitro"], options);
      else options.push({ path: [], value: null });
    }
    if (key !== "plugins" || property !== pluginsProperty) continue;
    collectNitroPluginOptions(property.value, pluginNames, namespaceNames, options);
  }
  return options;
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
      !["srcDir", "serverDir", "scanDirs", "apiDir", "routesDir", "nitro", "imports"].includes(key)
    )
      continue;
    const next = [...path, key];
    options.push({ path: next, value: literalValue(property.value) });
    if (key === "nitro") {
      const nested = unwrapConfig(property.value);
      if (nested) collectOptions(nested, next, options);
      else options.push({ path: [], value: null });
    }
  }
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
