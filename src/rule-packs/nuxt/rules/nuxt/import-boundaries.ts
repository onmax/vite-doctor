import { dirname, isAbsolute, relative, resolve } from "pathe";
import type { ProjectInfo, RuleContext } from "../../../../core/index.js";
import {
  readStaticConfigOptions,
  runtimeMajor,
  staticOptionValue,
} from "../../../nitro/rules/server-layout.js";
import { AnyNode, NUXT_APP_DIRS, toPosixPath } from "./shared.js";

const ROOT_RELATIVE_ALIASES = new Set(["~~", "@@"]);
const SRC_RELATIVE_ALIASES = new Set(["~", "@"]);
export const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export interface LayerDirs {
  root: string;
  srcDir?: string;
  serverDirs: string[];
  sharedDir: string;
  aliases?: Record<string, string>;
}

export type Side = "app" | "shared" | "server";
type NuxtLayer = NonNullable<ProjectInfo["nuxt"]>["layers"][number];

export interface BoundaryFile {
  file: string;
  layer: LayerDirs;
  layers: LayerDirs[];
  side: Side;
}

/** The file being linted, with its layer and side, or nothing for module sources and tests. */
export function boundaryFile(ctx: RuleContext): BoundaryFile | undefined {
  if (ctx.file.sourceKind === "module") return;
  if (TEST_FILE.test(toPosixPath(ctx.file.relativePath))) return;
  const layers = projectLayers(ctx);
  const file = toPosixPath(ctx.file.path);
  const layer = layerFor(ctx, file, layers);
  const side = sideOf(file, layer);
  return side ? { file, layer, layers, side } : undefined;
}

export function importVisitor(visit: (node: AnyNode) => void) {
  return {
    ImportDeclaration: visit,
    ExportAllDeclaration: visit,
    ExportNamedDeclaration: visit,
    ImportExpression: visit,
  };
}

export function importSource(node: AnyNode): AnyNode {
  if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") return node.source;
  if (node.type === "ExportNamedDeclaration") return node.source ?? undefined;
  if (node.type === "ImportExpression") return node.source;
}

export function staticString(node: AnyNode): string | undefined {
  if (
    (node?.type === "Literal" || node?.type === "StringLiteral") &&
    typeof node.value === "string"
  )
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions?.length === 0)
    return node.quasis?.[0]?.value?.cooked ?? undefined;
}

export function isTypeOnly(node: AnyNode): boolean {
  if (node.type === "ImportExpression") return false;
  if ((node.importKind ?? node.exportKind) === "type") return true;
  const specifiers: AnyNode[] = node.specifiers ?? [];
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => (specifier.importKind ?? specifier.exportKind) === "type")
  );
}

/** An absolute path for a relative or aliased specifier, or nothing for a bare package. */
export function resolveSpecifier(
  ctx: RuleContext,
  specifier: string,
  { file, layer, side }: BoundaryFile,
): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    return toPosixPath(resolve(dirname(file), specifier));
  const slash = specifier.indexOf("/");
  const head = slash === -1 ? specifier : specifier.slice(0, slash);
  const rest = slash === -1 ? "" : specifier.slice(slash + 1);
  const nuxt = ctx.project.nuxt;
  const root = toPosixPath(ctx.project.root);
  const nitroAliases = side === "server" ? nuxt?.nitroAutoImports?.aliases : undefined;
  const aliases = nitroAliases ?? nuxt?.manifest?.aliases ?? {};
  if (nitroAliases) {
    const resolved = resolveAlias(root, aliases, specifier);
    if (resolved) return resolved;
  }
  const localLayer =
    !nitroAliases &&
    layer.root !== root &&
    nuxt?.localLayerAliases !== false &&
    isInside(file, layerSrcDir(file, layer));
  if (ROOT_RELATIVE_ALIASES.has(head)) {
    const base = localLayer
      ? layerAlias(layer, head, layer.root)
      : absolute(root, aliases[head] ?? root);
    return rest ? resolveLayerAlias(base, rest, file) : undefined;
  }
  if (SRC_RELATIVE_ALIASES.has(head)) {
    const base = localLayer
      ? layerAlias(layer, head, layerSrcDir(file, layer))
      : absolute(root, aliases[head] ?? rootLayer(ctx).srcDir ?? root);
    return rest ? resolveLayerAlias(base, rest, file) : undefined;
  }
  if (head === "#server") {
    const base = rootLayer(ctx).serverDirs[0];
    return aliases[head] ? resolveAlias(root, aliases, specifier) : base && resolve(base, rest);
  }
  return nitroAliases ? undefined : resolveAlias(root, aliases, specifier);
}

function resolveAlias(root: string, aliases: Record<string, string>, specifier: string) {
  const alias = Object.keys(aliases)
    .filter((key) => specifier === key || specifier.startsWith(`${key}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!alias) return;
  return toPosixPath(resolve(absolute(root, aliases[alias]!), specifier.slice(alias.length + 1)));
}

function layerAlias(layer: LayerDirs, alias: string, fallback: string) {
  const value = layer.aliases?.[alias];
  return value || fallback;
}

function resolveLayerAlias(base: string, rest: string, file: string) {
  return toPosixPath(resolve(dirname(file), base, rest));
}

function layerSrcDir(file: string, layer: LayerDirs) {
  if (layer.srcDir) return layer.srcDir;
  const appDir = `${layer.root}/app`;
  if (isInside(file, appDir)) return appDir;
  return layer.srcDir ?? layer.root;
}

function absolute(root: string, path: string) {
  return toPosixPath(isAbsolute(path) ? path : resolve(root, path));
}

export function projectLayers(ctx: RuleContext): LayerDirs[] {
  const key = "nuxt:import-boundary-layers";
  const cached = ctx.cache.get<LayerDirs[]>(key);
  if (cached) return cached;
  const root = toPosixPath(ctx.project.root);
  const nuxt = ctx.project.nuxt;
  const inventory: NuxtLayer[] = [...(nuxt?.layers ?? [])];
  if (!inventory.some((layer) => absolute(root, layer.root) === root))
    inventory.push({ root, priority: 0 });
  const major = runtimeMajor(ctx.project, "nuxt") ?? 4;
  const options = readStaticConfigOptions(ctx, "nuxt");
  const configuredSrc = staticOptionValue(options, (path) => path.join(".") === "srcDir");
  const configuredServer = staticOptionValue(options, (path) => path.join(".") === "serverDir");
  const configuredShared = staticOptionValue(options, (path) => path.join(".") === "dir.shared");
  const layers = inventory.map((layer): LayerDirs => {
    const layerRoot = absolute(root, layer.root);
    const isRoot = layerRoot === root;
    const staticSrcDir = isRoot && typeof configuredSrc === "string" ? configuredSrc : undefined;
    const srcDir =
      layer.srcDir ??
      (isRoot && nuxt?.manifest?.hasManifest ? nuxt.appDir : staticSrcDir) ??
      (isRoot ? nuxt?.appDir : undefined);
    const serverDir = layer.serverDir ?? (isRoot ? configuredServer : undefined);
    const sharedDir =
      layer.sharedDir ??
      (isRoot && typeof configuredShared === "string"
        ? absolute(root, configuredShared)
        : undefined);
    return {
      root: layerRoot,
      srcDir: srcDir ? absolute(root, srcDir) : undefined,
      aliases: layer.aliases,
      serverDirs:
        typeof serverDir === "string"
          ? [absolute(root, serverDir)]
          : serverDir === null
            ? []
            : defaultServerDirs(layerRoot, major, staticSrcDir),
      sharedDir: sharedDir ? absolute(root, sharedDir) : resolve(layerRoot, "shared"),
    };
  });
  ctx.cache.set(key, layers);
  return layers;
}

export function rootLayer(ctx: RuleContext): LayerDirs {
  const root = toPosixPath(ctx.project.root);
  return projectLayers(ctx).find((layer) => layer.root === root)!;
}

export function layerFor(ctx: RuleContext, file: string, layers: LayerDirs[]): LayerDirs {
  const known = layers
    .filter((layer) => isInside(file, layer.root))
    .sort((a, b) => b.root.length - a.root.length)[0];
  const root = toPosixPath(ctx.project.root);
  const autoLayer = toPosixPath(relative(root, file)).match(/^layers\/[^/]+(?=\/)/)?.[0];
  if (autoLayer && (!known || known.root === root)) {
    const layerRoot = `${root}/${autoLayer}`;
    return {
      root: layerRoot,
      serverDirs: defaultServerDirs(layerRoot, runtimeMajor(ctx.project, "nuxt") ?? 4),
      sharedDir: resolve(layerRoot, "shared"),
    };
  }
  return known ?? rootLayer(ctx);
}

function defaultServerDirs(root: string, major: number, srcDir?: string) {
  if (major >= 4) return [resolve(root, "server")];
  if (srcDir) return [resolve(root, srcDir, "server")];
  return [resolve(root, "server"), resolve(root, "app/server")];
}

/** Which side of the app/server boundary a path inside `layer` belongs to. */
export function sideOf(file: string, layer: LayerDirs): Side | undefined {
  if (layer.serverDirs.some((dir) => isInside(file, dir))) return "server";
  if (isInside(file, layer.sharedDir)) return "shared";
  const path = toPosixPath(relative(layer.root, file));
  if (path.startsWith("app/") || /^(?:app|error)\.vue$/.test(path)) return "app";
  if (layer.srcDir && layer.srcDir !== layer.root && isInside(file, layer.srcDir)) return "app";
  const [first] = path.split("/");
  return first && NUXT_APP_DIRS.has(first) && path.includes("/") ? "app" : undefined;
}

export function isInside(path: string, dir: string) {
  return path === dir || path.startsWith(`${dir}/`);
}
