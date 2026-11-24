import { isAbsolute, join, relative, resolve } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../../core/index.js";
import { projectWorkspacePackages } from "../../../../core/internal/applicability.js";
import { readExportedNuxtOption } from "../../../../core/internal/runtime-graph.js";
import { parseScript } from "../../../../core/internal/script.js";
import {
  nuxtInventoryOwner,
  owningWorkspacePackage,
} from "../../../../core/internal/workspace-packages.js";
import { workspaceViewRoot } from "../../../../core/internal/workspace-nuxt.js";
import { diagnostics } from "../../diagnostics.js";
import type { AnyNode } from "./shared.js";

const RULE_ID = "nuxt/plugins/no-island-disabled-dependency";
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
        const packages = projectWorkspacePackages(ctx.project);
        const owner = workspaceViewRoot(ctx.project) ?? nuxtInventoryOwner(packages)?.root ?? ".";
        const root = join(ctx.project.root, owner);
        const islands = islandsRender(ctx);
        if (islands === false) return;
        const sources = new Set(await ctx.inventory.sourcePaths());
        const registered = ctx.project.nuxt?.manifest?.resolvedPlugins;
        if (!registered) {
          const explicit = explicitPluginCandidates(ctx, root, sources);
          const candidates = [...sources].filter(
            (file) =>
              owningWorkspacePackage(packages, relative(ctx.project.root, file)) === owner ||
              explicit.paths.has(file),
          );
          const plugins = readPlugins(ctx, candidates);
          if (
            findDependencies(plugins, false).length ||
            (explicit.unresolved && plugins.some(canDependDuringIslands))
          ) {
            recordRegistrationGap(ctx, root, islands === undefined ? "island" : "plugin");
          }
          return;
        }
        const plugins = readPlugins(
          ctx,
          registered
            .filter(({ file, mode }) => mode !== "client" && sources.has(file))
            .map(({ file }) => file),
        );
        // Duplicate or computed names can resolve a dependency through another plugin.
        if (plugins.some((plugin) => !plugin.readable)) return;
        const dependencies = findDependencies(plugins);
        if (!dependencies.length) return;
        if (islands === undefined) {
          recordRegistrationGap(ctx, root, "island");
          return;
        }
        for (const { plugin, dependency, target } of dependencies) {
          report(ctx, root, plugin, dependency, target);
        }
      },
    };
  },
});

function canDependDuringIslands(plugin: PluginMeta): boolean {
  return !plugin.islandsDisabled && !!plugin.dependsOn?.length;
}

function findDependencies(plugins: PluginMeta[], requireUnique = true) {
  const names = new Map<string, PluginMeta[]>();
  for (const plugin of plugins) {
    if (plugin.name === undefined) continue;
    names.set(plugin.name, [...(names.get(plugin.name) ?? []), plugin]);
  }
  return plugins.flatMap((plugin) =>
    (plugin.islandsDisabled ? [] : (plugin.dependsOn ?? [])).flatMap((dependency) => {
      const targets = names.get(dependency.name) ?? [];
      if (requireUnique && targets.length !== 1) return [];
      const target = targets.find((candidate) => candidate.islandsDisabled);
      return target ? [{ plugin, dependency, target }] : [];
    }),
  );
}

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

function readPlugins(ctx: RuleContext, files: string[]): PluginMeta[] {
  return files.flatMap((file) => {
    if (!/\.[cm]?[jt]sx?$/.test(file) || /\.d\.[cm]?ts$/.test(file)) return [];
    const text = ctx.fs.readText(file);
    if (!text || !/\bdefineNuxtPlugin\b/.test(text)) return [];
    const plugin = readPlugin(file, text);
    return plugin ? [plugin] : [];
  });
}

function explicitPluginCandidates(ctx: RuleContext, root: string, sources: Set<string>) {
  const paths = new Set<string>();
  let unresolved = false;
  for (const extension of ["ts", "mts", "js", "mjs", "cjs", "cts"]) {
    const config = join(root, `nuxt.config.${extension}`);
    const text = ctx.fs.readText(config);
    if (text === undefined) continue;
    const plugins = readExportedNuxtOption(config, text, "plugins");
    if (plugins?.type !== "ArrayExpression") {
      unresolved = plugins !== undefined;
      break;
    }
    for (const element of plugins.elements ?? []) {
      const entry = unwrap(element);
      const src =
        entry?.type === "ObjectExpression"
          ? entry.properties.findLast(
              (property: AnyNode) =>
                property.type === "Property" &&
                !property.computed &&
                (property.key.name ?? property.key.value) === "src",
            )?.value
          : entry;
      const value = unwrap(src)?.value;
      const path =
        typeof value !== "string"
          ? undefined
          : value.startsWith("./") || value.startsWith("../") || isAbsolute(value)
            ? resolve(root, value)
            : value.startsWith("~~/") || value.startsWith("@@/")
              ? resolve(root, value.slice(3))
              : undefined;
      if (path && sources.has(path)) paths.add(path);
      else unresolved = true;
    }
    break;
  }
  return { paths, unresolved };
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
function islandsRender(ctx: RuleContext): boolean | undefined {
  const inventory = ctx.project.nuxt?.manifest;
  if (inventory?.componentIslands === false) return false;
  if (inventory?.componentIslands === undefined) return undefined;
  if (inventory?.hasServerPageIslands) return true;
  const components = inventory?.resolvedComponents;
  if (components) {
    const clients = new Set(
      components.filter(({ mode }) => mode === "client").map(({ name }) => name),
    );
    if (components.some(({ name, mode }) => mode === "server" && !clients.has(name))) return true;
  }
  return components && inventory?.hasServerPageIslands === false ? false : undefined;
}

function recordRegistrationGap(ctx: RuleContext, root: string, kind: "island" | "plugin") {
  const manifestPath = ctx.project.nuxt?.manifestPath ?? join(root, ".nuxt/doctor.manifest.json");
  const file = relative(ctx.project.root, manifestPath);
  const source = `${RULE_ID}/${kind}-registration`;
  const gaps = (ctx.project.evidenceGaps ??= []);
  if (gaps.some((gap) => gap.source === source && gap.files.includes(file))) return;
  gaps.push({
    source,
    message: `Doctor could not verify current Nuxt ${kind} registrations. Run nuxt prepare with vite-doctor/nuxt to write the Doctor manifest.`,
    files: [file],
  });
}
