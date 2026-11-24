import { basename, dirname, join, relative, resolve } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../../core/index.js";
import { readExportedExperimentalOption } from "../../../../core/internal/runtime-graph.js";
import { parseScript } from "../../../../core/internal/script.js";
import { workspaceViewRoot } from "../../../../core/internal/workspace-nuxt.js";
import { diagnostics } from "../../diagnostics.js";
import type { AnyNode } from "./shared.js";

const RULE_ID = "nuxt/plugins/no-island-disabled-dependency";
const PLUGIN_FILE_RE = /^(?:[^/]+|[^/]+\/index)\.(?:[cm]?[jt]s|[jt]sx)$/;
const CONFIG_FILES = ["ts", "mts", "js", "mjs", "cts", "cjs"].map((ext) => `nuxt.config.${ext}`);
// Server components without a client counterpart, island components, and server pages render as
// islands (nuxt/dist/index.mjs hasActiveComponentIslands).
const SERVER_COMPONENT_RE = /\.server\.vue$/;
const ISLAND_COMPONENT_RE = /\.island(?:\.global)?\.vue$/;
const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"]);

interface PluginMeta {
  file: string;
  text: string;
  name?: string;
  /** Unset when the plugin object is not literal enough to read its metadata. */
  dependsOn?: Array<{ name: string; node: AnyNode }>;
  islandsDisabled?: { node: AnyNode };
  clientOnly: boolean;
  readable: boolean;
}

export const noIslandDisabledPluginDependency = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not depend on island-disabled plugins",
    category: "plugins",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/directory-structure/app/plugins#object-syntax-plugins",
    execution: "workspace",
    cacheScope: "none",
    requires: { nuxt: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast"],
    cost: "small",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const app = appRoots(ctx);
        if (!app) return;
        const sources = await ctx.inventory.sourcePaths();
        const plugins = readPlugins(ctx, app, sources);
        if (!plugins.length || !plugins.some((plugin) => plugin.islandsDisabled)) return;
        // Duplicate or computed names can resolve a dependency through another plugin.
        if (plugins.some((plugin) => !plugin.readable)) return;
        const names = new Map<string, PluginMeta[]>();
        for (const plugin of plugins) {
          if (plugin.name === undefined) continue;
          names.set(plugin.name, [...(names.get(plugin.name) ?? []), plugin]);
        }
        if (!islandsRender(ctx, app, sources)) return;
        for (const plugin of plugins) {
          if (plugin.clientOnly || plugin.islandsDisabled || !plugin.dependsOn) continue;
          for (const dependency of plugin.dependsOn) {
            const [target, ...others] = names.get(dependency.name) ?? [];
            if (!target || others.length || target.clientOnly || !target.islandsDisabled) continue;
            report(ctx, app.root, plugin, dependency, target);
          }
        }
      },
    };
  },
});

function report(
  ctx: RuleContext,
  root: string,
  plugin: PluginMeta,
  dependency: { name: string; node: AnyNode },
  target: PluginMeta,
) {
  const targetPath = relative(root, target.file);
  ctx.report(
    diagnostics.NUXT0104({
      why: `This plugin depends on '${dependency.name}' (${targetPath}), which sets env: { islands: false }. When Nuxt renders a server component island it skips '${dependency.name}', so it never resolves, and this plugin waits for it and silently never runs in that render.`,
      fix: `Remove '${dependency.name}' from dependsOn if this plugin can run without it, or set env: { islands: false } on this plugin too so neither runs in islands.`,
      sources: [`${targetPath}:${rangeOf(ctx, target, target.islandsDisabled!.node).line}`],
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "plugins",
      file: plugin.file,
      range: rangeOf(ctx, plugin, dependency.node),
      confidence: "heuristic-high",
      related: [
        {
          file: target.file,
          range: rangeOf(ctx, target, target.islandsDisabled!.node),
          message: `'${dependency.name}' opts out of island renders here`,
        },
      ],
    },
  );
}

function rangeOf(ctx: RuleContext, plugin: PluginMeta, node: AnyNode): SourceRange {
  return ctx.helpers.rangeFromOffsets(plugin.file, plugin.text, node.start, node.end);
}

interface AppRoots {
  root: string;
  configRoots: string[];
  pluginDirs: string[];
}

function appRoots(ctx: RuleContext): AppRoots | undefined {
  const { project } = ctx;
  const nuxt = project.nuxt;
  if (!nuxt) return undefined;
  const root = resolve(
    project.root,
    workspaceViewRoot(project) ??
      (nuxt.manifestPath ? dirname(dirname(nuxt.manifestPath)) : (nuxt.layers[0]?.root ?? ".")),
  );
  const layers = nuxt.layers.map((layer) => ({
    root: resolve(root, layer.root),
    srcDir: layer.srcDir && resolve(root, layer.srcDir),
  }));
  const pluginDirs = new Set([join(resolve(root, nuxt.appDir), "plugins")]);
  for (const layer of layers) {
    if (layer.srcDir) pluginDirs.add(join(layer.srcDir, "plugins"));
    else {
      pluginDirs.add(join(layer.root, "plugins"));
      pluginDirs.add(join(layer.root, "app/plugins"));
    }
  }
  return {
    root,
    configRoots: [...new Set([root, ...layers.map((layer) => layer.root)])],
    pluginDirs: [...pluginDirs],
  };
}

function readPlugins(ctx: RuleContext, app: AppRoots, sources: readonly string[]): PluginMeta[] {
  const explicit = new Set(ctx.project.nuxt?.manifest?.pluginFiles ?? []);
  const files = sources.filter(
    (file) =>
      !/\.d\.[cm]?ts$/.test(file) &&
      (explicit.has(file) ||
        app.pluginDirs.some((dir) => {
          const path = relative(dir, file);
          return !path.startsWith("..") && PLUGIN_FILE_RE.test(path);
        })),
  );
  return files.flatMap((file) => {
    const text = ctx.fs.readText(file);
    if (!text || !/\bdefineNuxtPlugin\b/.test(text)) return [];
    const plugin = readPlugin(file, text);
    return plugin ? [plugin] : [];
  });
}

function readPlugin(file: string, text: string): PluginMeta | undefined {
  const clientOnly = /\.client\.[^/.]+$/.test(basename(file));
  const unreadable = { file, text, clientOnly, readable: false };
  const program = parseScript(file, text) as AnyNode;
  if (!program) return unreadable;
  const exported = program.body?.find(
    (statement: AnyNode) => statement.type === "ExportDefaultDeclaration",
  )?.declaration;
  const call = unwrap(exported);
  if (call?.type !== "CallExpression" || call.callee?.name !== "defineNuxtPlugin") return undefined;
  const object = unwrap(call.arguments?.[0]);
  // A function plugin has no name, dependsOn or env.
  if (FUNCTION_TYPES.has(object?.type)) return undefined;
  if (object?.type !== "ObjectExpression") return unreadable;
  const plugin: PluginMeta = { file, text, clientOnly, readable: true };
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed) return unreadable;
    const key = property.key.name ?? property.key.value;
    const value = unwrap(property.value);
    if (key === "name") {
      if (typeof value?.value !== "string") return unreadable;
      plugin.name = value.value;
    } else if (key === "dependsOn") {
      if (value?.type !== "ArrayExpression") continue;
      const names = value.elements.map((element: AnyNode) =>
        typeof element?.value === "string" ? { name: element.value, node: element } : undefined,
      );
      if (names.every(Boolean)) plugin.dependsOn = names;
    } else if (key === "env") {
      if (value?.type !== "ObjectExpression") return unreadable;
      for (const option of value.properties) {
        if (option.type !== "Property" || option.computed) return unreadable;
        if ((option.key.name ?? option.key.value) !== "islands") continue;
        const islands = unwrap(option.value);
        if (typeof islands?.value !== "boolean") return unreadable;
        if (islands.value === false) plugin.islandsDisabled = { node: option };
      }
    }
  }
  return plugin;
}

const FUNCTION_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression"]);

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (WRAPPERS.has(current?.type)) current = current.expression;
  return current;
}

/**
 * Whether island renders can happen: experimental.componentIslands is not turned off and the app
 * has a component or page that renders as an island.
 */
function islandsRender(ctx: RuleContext, app: AppRoots, sources: readonly string[]): boolean {
  for (const root of app.configRoots) {
    const file = CONFIG_FILES.map((name) => join(root, name)).find((path) => ctx.fs.exists(path));
    if (!file) continue;
    const text = ctx.fs.readText(file);
    if (text === undefined) return false;
    const value = readExportedExperimentalOption(file, text, "componentIslands");
    if (value === null) return false;
    if (value === undefined) continue;
    if (value.type === "Literal" && value.value === false) return false;
    break;
  }
  const components = ctx.project.nuxt?.components;
  if (
    [...(components?.values() ?? [])].some(
      (component) =>
        component.mode === "server" &&
        ![...components!.values()].some(
          (other) => other.name === component.name && other.mode === "client",
        ),
    )
  )
    return true;
  const vueFiles = new Set(sources.filter((file) => file.endsWith(".vue")));
  return [...vueFiles].some(
    (file) =>
      ISLAND_COMPONENT_RE.test(file) ||
      (SERVER_COMPONENT_RE.test(file) &&
        !vueFiles.has(file.replace(SERVER_COMPONENT_RE, ".client.vue"))),
  );
}
