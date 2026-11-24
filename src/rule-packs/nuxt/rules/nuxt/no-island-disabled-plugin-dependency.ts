import { basename, dirname, join, relative, resolve } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../../core/index.js";
import {
  readExportedExperimentalOption,
  readExportedNuxtOption,
} from "../../../../core/internal/runtime-graph.js";
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
          if (plugin.islandsDisabled || !plugin.dependsOn) continue;
          for (const dependency of plugin.dependsOn) {
            const [target, ...others] = names.get(dependency.name) ?? [];
            if (!target || others.length || !target.islandsDisabled) continue;
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
  sourceDirs: string[];
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
  const sourceDirs = new Set([resolve(root, nuxt.appDir)]);
  for (const layer of layers) {
    if (layer.root === root) continue;
    const defaultDir = ctx.fs.exists(join(layer.root, "app"))
      ? join(layer.root, "app")
      : layer.root;
    sourceDirs.add(layer.srcDir ?? defaultDir);
  }
  return {
    root,
    configRoots: [...new Set([root, ...layers.map((layer) => layer.root)])],
    pluginDirs: [...sourceDirs].map((dir) => join(dir, "plugins")),
    sourceDirs: [...sourceDirs],
  };
}

function readPlugins(ctx: RuleContext, app: AppRoots, sources: readonly string[]): PluginMeta[] {
  const inventory = ctx.project.nuxt?.manifest;
  const modes =
    inventory?.resolvedPlugins &&
    new Map(inventory.resolvedPlugins.map(({ file, mode }) => [file, mode]));
  const explicit = new Set(inventory?.pluginFiles ?? []);
  if (
    !modes &&
    (sources.some((file) => explicit.has(file)) ||
      readRegistration(ctx, app, "plugins") !== undefined ||
      readRegistration(ctx, app, "dir") !== undefined)
  ) {
    recordRegistrationGap(ctx, "plugin");
    return [];
  }
  const files = sources.filter(
    (file) =>
      !/\.d\.[cm]?ts$/.test(file) &&
      (modes
        ? modes.has(file) && modes.get(file) !== "client"
        : !/\.client\.[^/.]+$/.test(basename(file)) &&
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
  const unreadable = { file, text, readable: false };
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
  const plugin: PluginMeta = { file, text, readable: true };
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
  const inventory = ctx.project.nuxt?.manifest;
  if (inventory?.componentIslands === false) return false;
  if (inventory?.componentIslands === undefined) {
    const value = readRegistration(ctx, app, "componentIslands", true);
    if (
      value !== undefined &&
      !(value?.type === "Literal" && [true, "auto"].includes(value.value)) &&
      value?.type !== "ObjectExpression"
    )
      return false;
  }
  if (inventory?.hasServerPageIslands) return true;
  const components = inventory?.resolvedComponents;
  if (components) {
    const clients = new Set(
      components.filter(({ mode }) => mode === "client").map(({ name }) => name),
    );
    if (components.some(({ name, mode }) => mode === "server" && !clients.has(name))) return true;
  }
  if (components && inventory?.hasServerPageIslands === false) return false;
  const defaults = (option: string) => {
    const value = readRegistration(ctx, app, option);
    return value === undefined || (value?.type === "Literal" && value.value === true);
  };
  if (
    readRegistration(ctx, app, "dir") !== undefined ||
    readRegistration(ctx, app, "srcDir") !== undefined
  ) {
    recordRegistrationGap(ctx, "island");
    return false;
  }
  const checkComponents = !components && defaults("components");
  const checkPages = inventory?.hasServerPageIslands === undefined && defaults("pages");
  const vueFiles = new Set(sources.filter((file) => file.endsWith(".vue")));
  const matches = app.sourceDirs.some((dir) =>
    [...vueFiles].some((file) => {
      const path = relative(dir, file);
      if (checkPages && /^pages\/[\w-]+\.server\.vue$/.test(path))
        return !vueFiles.has(file.replace(SERVER_COMPONENT_RE, ".client.vue"));
      if (!checkComponents || !path.startsWith("components/")) return false;
      return (
        path.startsWith("components/islands/") ||
        ISLAND_COMPONENT_RE.test(path) ||
        (SERVER_COMPONENT_RE.test(path) &&
          !vueFiles.has(file.replace(SERVER_COMPONENT_RE, ".client.vue")))
      );
    }),
  );
  if (!matches) recordRegistrationGap(ctx, "island");
  return matches;
}

function recordRegistrationGap(ctx: RuleContext, kind: "island" | "plugin") {
  const manifestPath = ctx.project.nuxt?.manifestPath;
  if (!manifestPath) return;
  const source = `${RULE_ID}/${kind}-registration`;
  const gaps = (ctx.project.evidenceGaps ??= []);
  if (gaps.some((gap) => gap.source === source)) return;
  gaps.push({
    source,
    message: `Doctor could not verify current Nuxt ${kind} registrations. Run nuxt prepare to refresh the Doctor manifest.`,
    files: [relative(ctx.project.root, manifestPath)],
  });
}

function readRegistration(ctx: RuleContext, app: AppRoots, key: string, experimental = false) {
  for (const root of app.configRoots) {
    const file = CONFIG_FILES.map((name) => join(root, name)).find((path) => ctx.fs.exists(path));
    if (!file) continue;
    const text = ctx.fs.readText(file);
    if (text === undefined) return null;
    const value = experimental
      ? readExportedExperimentalOption(file, text, key)
      : readExportedNuxtOption(file, text, key);
    if (value !== undefined) return value;
  }
}
