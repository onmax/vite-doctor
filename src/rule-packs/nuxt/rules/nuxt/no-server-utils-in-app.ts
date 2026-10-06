import { dirname, isAbsolute, relative, resolve } from "pathe";
import type { ProjectInfo, RuleContext } from "../../../../core/index.js";
import { AnyNode, NUXT_APP_DIRS, createRule, toPosixPath } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const VALUE_RULE_ID = "nuxt/structure/no-server-utils-in-app";
const TYPE_RULE_ID = "nuxt/structure/no-server-types-in-app";
const NUXT_PROTECTED_SERVER_SUBDIR = /^(api|routes|middleware|plugins)(\/|$)/;
const ROOT_RELATIVE_ALIASES = new Set(["~~", "@@"]);
const SRC_RELATIVE_ALIASES = new Set(["~", "@"]);
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;

interface LayerDirs {
  root: string;
  srcDir?: string;
  serverDirs: string[];
  aliases?: Record<string, string>;
}

interface ServerImport {
  node: AnyNode;
  specifier: string;
  target: string;
  typeOnly: boolean;
}

type Side = "app" | "shared";
type NuxtLayer = NonNullable<ProjectInfo["nuxt"]>["layers"][number];

const layersByProject = new WeakMap<ProjectInfo, LayerDirs[]>();

export const noServerUtilsInApp = createRule({
  meta: {
    id: VALUE_RULE_ID,
    title: "Do not import server code into app or shared code",
    category: "architecture",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/directory-structure/shared",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return serverImportVisitor(ctx, false, (found, side) => {
      ctx.report(
        diagnostics.NUXT0075({
          why: `${found.specifier} resolves to ${found.target}, which Nuxt's import protection does not block. Importing it from ${side} code bundles server code into the client.`,
          fix: "Move code needed by both sides to shared/utils/, which Nuxt auto-imports in the app and the server. Call server-only logic through an API route with $fetch() or useFetch().",
        }),
        {
          ruleId: VALUE_RULE_ID,
          severity: "error",
          category: "architecture",
          file: ctx.file.path,
          range: ctx.range(found.node),
        },
      );
    });
  },
});

export const noServerTypesInApp = createRule({
  meta: {
    id: TYPE_RULE_ID,
    title: "Keep types shared by app and server in shared/types",
    category: "architecture",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/directory-structure/shared",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return serverImportVisitor(ctx, true, (found, side) => {
      ctx.report(
        diagnostics.NUXT0076({
          why: `${side === "app" ? "App" : "Shared"} code imports types from ${found.target}, which couples it to server internals.`,
          fix: "Move the shared types to shared/types/, which Nuxt auto-imports in the app and the server, and import them from there in server code too.",
        }),
        {
          ruleId: TYPE_RULE_ID,
          severity: "info",
          category: "architecture",
          file: ctx.file.path,
          range: ctx.range(found.node),
        },
      );
    });
  },
});

function serverImportVisitor(
  ctx: RuleContext,
  typeOnly: boolean,
  onImport: (found: ServerImport, side: Side) => void,
) {
  if (ctx.file.sourceKind === "module") return;
  const relativePath = toPosixPath(ctx.file.relativePath);
  if (TEST_FILE.test(relativePath)) return;
  const layers = projectLayers(ctx);
  const file = toPosixPath(ctx.file.path);
  const layer = layerFor(file, layers, ctx.project.root);
  const side = clientSide(file, layer);
  if (!side) return;
  return {
    ScriptNode(node: AnyNode) {
      const found = serverImport(ctx, node, file, layer, layers);
      if (found && found.typeOnly === typeOnly) onImport(found, side);
    },
  };
}

function serverImport(
  ctx: RuleContext,
  node: AnyNode,
  file: string,
  layer: LayerDirs,
  layers: LayerDirs[],
): ServerImport | undefined {
  const source = importSource(node);
  if (!source) return;
  const specifier = staticString(source);
  if (!specifier) return;
  const resolved = resolveSpecifier(ctx, specifier, file, layer);
  if (!resolved) return;
  const targetLayer = layerFor(resolved, layers, ctx.project.root);
  const serverDir = targetLayer.serverDirs.find((dir) => isInside(resolved, dir));
  if (!serverDir) return;
  const foundTypeOnly = isTypeOnly(node);
  const isRootLayer = targetLayer.root === toPosixPath(ctx.project.root);
  if (
    isRootLayer &&
    !foundTypeOnly &&
    NUXT_PROTECTED_SERVER_SUBDIR.test(relative(serverDir, resolved))
  )
    return;
  return {
    node: source,
    specifier,
    target: toPosixPath(relative(ctx.project.root, resolved)) || ".",
    typeOnly: foundTypeOnly,
  };
}

function importSource(node: AnyNode): AnyNode {
  if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") return node.source;
  if (node.type === "ExportNamedDeclaration") return node.source ?? undefined;
  if (node.type === "ImportExpression") return node.source;
}

function staticString(node: AnyNode): string | undefined {
  if (
    (node?.type === "Literal" || node?.type === "StringLiteral") &&
    typeof node.value === "string"
  )
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions?.length === 0)
    return node.quasis?.[0]?.value?.cooked ?? undefined;
}

function isTypeOnly(node: AnyNode): boolean {
  if (node.type === "ImportExpression") return false;
  if ((node.importKind ?? node.exportKind) === "type") return true;
  const specifiers: AnyNode[] = node.specifiers ?? [];
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => (specifier.importKind ?? specifier.exportKind) === "type")
  );
}

function resolveSpecifier(
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
      ? layerAlias(layer, head, root, layer.root)
      : absolute(root, aliases[head] ?? root);
    return rest ? toPosixPath(resolve(base, rest)) : undefined;
  }
  if (SRC_RELATIVE_ALIASES.has(head)) {
    const base = localLayer
      ? layerAlias(layer, head, root, layerSrcDir(file, layer))
      : absolute(root, aliases[head] ?? nuxt?.appDir ?? root);
    return rest ? toPosixPath(resolve(base, rest)) : undefined;
  }
  if (specifier === "#server" || specifier.startsWith("#server/")) return;
  const alias = Object.keys(aliases)
    .filter(
      (key) => !key.startsWith("#server") && (specifier === key || specifier.startsWith(`${key}/`)),
    )
    .sort((a, b) => b.length - a.length)[0];
  if (!alias) return;
  return toPosixPath(resolve(absolute(root, aliases[alias]!), specifier.slice(alias.length + 1)));
}

function layerAlias(layer: LayerDirs, alias: string, root: string, fallback: string) {
  const value = layer.aliases?.[alias];
  return value ? absolute(root, value) : fallback;
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

function projectLayers(ctx: RuleContext): LayerDirs[] {
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

function layerFor(file: string, layers: LayerDirs[], projectRoot: string): LayerDirs {
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

function clientSide(file: string, layer: LayerDirs): Side | undefined {
  if (layer.serverDirs.some((dir) => isInside(file, dir))) return;
  const path = toPosixPath(relative(layer.root, file));
  if (path.startsWith("shared/")) return "shared";
  if (path.startsWith("app/") || path === "app.vue" || path === "error.vue") return "app";
  if (layer.srcDir && layer.srcDir !== layer.root && isInside(file, layer.srcDir)) return "app";
  const [first] = path.split("/");
  return first && NUXT_APP_DIRS.has(first) && path.includes("/") ? "app" : undefined;
}

function isInside(path: string, dir: string) {
  return path === dir || path.startsWith(`${dir}/`);
}
