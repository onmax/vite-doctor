import { dirname, isAbsolute, relative, resolve } from "pathe";
import type { ProjectInfo, RuleContext } from "../../../../core/index.js";
import { AnyNode, NUXT_APP_DIRS, toPosixPath } from "./shared.js";

const ROOT_RELATIVE_ALIASES = new Set(["~~", "@@"]);
const SRC_RELATIVE_ALIASES = new Set(["~", "@"]);
export const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export interface LayerDirs {
  root: string;
  srcDir?: string;
  serverDirs: string[];
  aliases?: Record<string, string>;
}

export type Side = "app" | "shared" | "server";
type NuxtLayer = NonNullable<ProjectInfo["nuxt"]>["layers"][number];

const layersByProject = new WeakMap<ProjectInfo, LayerDirs[]>();

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
  const layer = layerFor(file, layers, ctx.project.root);
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
  file: string,
  layer: LayerDirs,
): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    return toPosixPath(resolve(dirname(file), specifier));
  const slash = specifier.indexOf("/");
  const head = slash === -1 ? specifier : specifier.slice(0, slash);
  const rest = slash === -1 ? "" : specifier.slice(slash + 1);
  const nuxt = ctx.project.nuxt;
  const root = toPosixPath(ctx.project.root);
  const localLayer =
    layer.root !== root &&
    nuxt?.localLayerAliases !== false &&
    isInside(file, layerSrcDir(file, layer));
  const aliases = nuxt?.manifest?.aliases ?? {};
  if (ROOT_RELATIVE_ALIASES.has(head)) {
    const base = localLayer
      ? layerAlias(layer, head, layer.root)
      : absolute(root, aliases[head] ?? root);
    return rest ? resolveLayerAlias(base, rest, file) : undefined;
  }
  if (SRC_RELATIVE_ALIASES.has(head)) {
    const base = localLayer
      ? layerAlias(layer, head, layerSrcDir(file, layer))
      : absolute(root, aliases[head] ?? nuxt?.appDir ?? root);
    return rest ? resolveLayerAlias(base, rest, file) : undefined;
  }
  if (head === "#server") {
    const base = aliases["#server"]
      ? absolute(root, aliases["#server"])
      : rootLayer(ctx).serverDirs[0]!;
    return toPosixPath(resolve(base, rest));
  }
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
  const cached = layersByProject.get(ctx.project);
  if (cached) return cached;
  const root = toPosixPath(ctx.project.root);
  const nuxt = ctx.project.nuxt;
  const inventory: NuxtLayer[] = nuxt?.layers?.length ? nuxt.layers : [{ root, priority: 0 }];
  const layers = inventory.map((layer): LayerDirs => {
    const layerRoot = absolute(root, layer.root);
    const isRoot = layerRoot === root;
    const srcDir = isRoot && nuxt?.appDir ? absolute(root, nuxt.appDir) : layer.srcDir;
    return {
      root: layerRoot,
      srcDir: srcDir ? absolute(root, srcDir) : undefined,
      aliases: layer.aliases,
      serverDirs: layer.serverDir
        ? [absolute(root, layer.serverDir)]
        : defaultServerDirs(layerRoot),
    };
  });
  layersByProject.set(ctx.project, layers);
  return layers;
}

export function rootLayer(ctx: RuleContext): LayerDirs {
  const root = toPosixPath(ctx.project.root);
  return (
    projectLayers(ctx).find((layer) => layer.root === root) ?? {
      root,
      serverDirs: defaultServerDirs(root),
    }
  );
}

export function layerFor(file: string, layers: LayerDirs[], projectRoot: string): LayerDirs {
  const known = layers
    .filter((layer) => isInside(file, layer.root))
    .sort((a, b) => b.root.length - a.root.length)[0];
  const root = toPosixPath(projectRoot);
  const autoLayer = toPosixPath(relative(root, file)).match(/^layers\/[^/]+(?=\/)/)?.[0];
  if (autoLayer && (!known || known.root === root)) {
    const layerRoot = `${root}/${autoLayer}`;
    return { root: layerRoot, serverDirs: defaultServerDirs(layerRoot) };
  }
  return known ?? { root, serverDirs: defaultServerDirs(root) };
}

function defaultServerDirs(root: string) {
  return [`${root}/server`, `${root}/app/server`];
}

/** Which side of the app/server boundary a path inside `layer` belongs to. */
export function sideOf(file: string, layer: LayerDirs): Side | undefined {
  if (layer.serverDirs.some((dir) => isInside(file, dir))) return "server";
  const path = toPosixPath(relative(layer.root, file));
  if (path.startsWith("shared/")) return "shared";
  if (path.startsWith("app/") || /^(?:app|error)\.vue$/.test(path)) return "app";
  if (layer.srcDir && layer.srcDir !== layer.root && isInside(file, layer.srcDir)) return "app";
  const [first] = path.split("/");
  return first && NUXT_APP_DIRS.has(first) && path.includes("/") ? "app" : undefined;
}

export function isInside(path: string, dir: string) {
  return path === dir || path.startsWith(`${dir}/`);
}
