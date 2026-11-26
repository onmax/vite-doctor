import { basename, dirname, join, relative, resolve } from "pathe";
import type {
  ComponentUsageGraph,
  ComponentUsageFact,
  RuleContext,
  SourceRange,
  TemplateElementNode,
  TemplateRootNode,
} from "../../../../core/index.js";
import { camelize } from "../../../../core/internal/component-facts.js";
import { parseScript } from "../../../../core/internal/script.js";
import type { NuxtAppInventoryKind } from "../../../../core/primitives.js";
import { parseSfcFile } from "../../../../core/internal/sfc.js";
import {
  findTemplateDirective,
  TemplateNodeType,
  templateRoots,
} from "../../../../core/internal/template.js";
import {
  nuxtAppSources,
  nuxtInventoryRoot,
  toPosixPath,
  type NuxtAppSource,
} from "./file-classification.js";
import {
  ENVIRONMENT_OVERRIDE_KEYS,
  exportedConfigObject,
  objectExpression,
  propertyName,
  topLevelBindings,
  unwrap,
} from "./nuxt-config-ast.js";
import type { AnyNode } from "./shared.js";

// nuxt.options.extensions, which Nuxt scans pages/ and layouts/ with.
const NUXT_EXTENSIONS = /\.(?:vue|[cm]?[jt]sx?)$/;
// Nuxt's default `ignore` drops declarations, tests, stories, and `ignorePrefix` (`-`) files.
const NUXT_IGNORED = /(?:\.d\.(?:vue\.)?[cm]?ts|\.(?:spec|test|stories)\.[cm]?[jt]sx?)$/;
const NUXT_CONFIG_FILES = ["ts", "mts", "js", "mjs", "cjs", "cts"].map(
  (extension) => `nuxt.config.${extension}`,
);

/** A file Nuxt registers as a page or layout from its directory. */
export function isScannedNuxtFile(file: string): boolean {
  return NUXT_EXTENSIONS.test(file) && !NUXT_IGNORED.test(file) && !basename(file).startsWith("-");
}

export function isInsideDir(file: string, dir: string): boolean {
  return file.startsWith(`${dir}/`);
}

export function displayPath(ctx: RuleContext, file: string): string {
  return toPosixPath(relative(ctx.project.root, file));
}

/** Nuxt layers of the Doctor Run's main app, highest priority first, then other Nuxt apps. */
export function nuxtLayerSources(ctx: RuleContext): NuxtAppSource[][] {
  const sources = nuxtAppSources(ctx);
  const byRoot = new Map(sources.map((source) => [source.root, source]));
  const layers = [...(ctx.project.nuxt?.layers ?? [])]
    .sort((left, right) => left.priority - right.priority)
    .map((layer) => byRoot.get(toPosixPath(resolve(ctx.project.root, layer.root))))
    .filter((source): source is NuxtAppSource => !!source);
  const apps = layers.length ? [layers] : [];
  const workspaceApps = new Set(
    (ctx.project.workspaceNuxt ?? []).map(({ root }) =>
      toPosixPath(resolve(ctx.project.root, root)),
    ),
  );
  for (const source of sources)
    if (!layers.includes(source) && !workspaceApps.has(source.root)) apps.push([source]);
  return apps;
}

export function pascalTag(tag: string): string {
  const camel = camelize(tag);
  return (camel.charAt(0).toUpperCase() + camel.slice(1)).replace(/^Lazy(?=[A-Z])/, "");
}

export type OutletSearch =
  | { state: "renders" }
  | { state: "unknown"; reason: string }
  | { state: "absent" };

export const PAGE_OUTLETS = new Set(["NuxtPage", "RouterView"]);
export const LAYOUT_OUTLETS = new Set(["NuxtLayout"]);
export const PAGE_OUTLET_MENTION = /\b(?:NuxtPage|RouterView|nuxt-page|router-view)\b/;
export const LAYOUT_OUTLET_MENTION = /\b(?:NuxtLayout|nuxt-layout)\b/;

const componentNamesByGraph = new WeakMap<ComponentUsageGraph, Map<string, string[]>>();

/**
 * Whether the SFC renders one of `outlets` itself or through components it renders. An outlet
 * Doctor could reach only through a guess, such as an auto-imported tag it cannot resolve or a
 * render function, makes the answer `unknown`.
 */
export function findOutlet(
  ctx: RuleContext,
  graph: ComponentUsageGraph,
  start: string,
  outlets: ReadonlySet<string>,
  mention: RegExp,
): OutletSearch {
  const { usages, unknown } = reachableOutlets(ctx, graph, start, outlets, mention);
  if (usages.length) return { state: "renders" };
  return unknown ? { state: "unknown", reason: unknown } : { state: "absent" };
}

export function reachableOutlets(
  ctx: RuleContext,
  graph: ComponentUsageGraph,
  start: string,
  outlets: ReadonlySet<string>,
  mention: RegExp,
) {
  let byName: Map<string, string[]> | undefined;
  const registry = ctx.project.nuxt?.components;
  const queue: Array<{ file: string; certain: boolean }> = [{ file: start, certain: true }];
  const seen = new Map<string, boolean>();
  const usages: ComponentUsageFact[] = [];
  let unknown: string | undefined;
  while (queue.length) {
    const { file, certain } = queue.shift()!;
    if (seen.get(file) === true || (seen.has(file) && !certain)) continue;
    seen.set(file, certain);
    const node = graph.components.get(file);
    const text = ctx.fs.readText(file);
    const name = displayPath(ctx, file);
    if (!node || !text) {
      unknown ??= `Doctor has no component facts for ${name}.`;
      continue;
    }
    const found = node.facts.usages.filter((usage) => outlets.has(pascalTag(usage.tag)));
    if (found.length) {
      if (certain) usages.push(...found);
      else unknown ??= `An auto-imported tag may resolve to ${name}, which renders the outlet.`;
    }
    if (!/<template[\s>]/.test(text)) {
      unknown ??= `${name} has no <template>, so it may render through a render function.`;
      continue;
    }
    if (!found.length && mention.test(text))
      unknown ??= `${name} names the outlet outside a template tag.`;
    if (/<component[\s>/]/.test(text))
      unknown ??= `${name} renders a dynamic <component :is>, which Doctor cannot resolve.`;
    for (const edge of node.renders) {
      if (edge.target) {
        queue.push({ file: edge.target, certain });
        continue;
      }
      const tag = pascalTag(edge.usage.tag);
      if (outlets.has(tag)) continue;
      const entry = registry?.get(tag) ?? registry?.get(edge.usage.tag);
      if (entry?.file || node.facts.imports.some((binding) => pascalTag(binding.local) === tag)) {
        unknown ??= `Doctor cannot follow <${edge.usage.tag}> in ${name}.`;
        continue;
      }
      for (const candidate of tagCandidates(tag, (byName ??= componentsByName(graph))))
        queue.push({ file: candidate, certain: false });
    }
  }
  return { usages, unknown };
}

function componentsByName(graph: ComponentUsageGraph): Map<string, string[]> {
  const cached = componentNamesByGraph.get(graph);
  if (cached) return cached;
  const byName = new Map<string, string[]>();
  for (const file of graph.components.keys()) {
    const base = basename(file).replace(/\.vue$/, "");
    const name = pascalTag(base === "index" ? basename(dirname(file)) : base);
    const files = byName.get(name);
    if (files) files.push(file);
    else byName.set(name, [file]);
  }
  componentNamesByGraph.set(graph, byName);
  return byName;
}

// Nuxt prefixes auto-imported component names with their directories, so `UsersShell` can be
// `components/users/Shell.vue`: any PascalCase suffix of the tag can name the file.
function tagCandidates(tag: string, byName: Map<string, string[]>): string[] {
  const files: string[] = [];
  for (let index = 0; index < tag.length; index++) {
    if (index && !/[A-Z]/.test(tag[index]!)) continue;
    files.push(...(byName.get(tag.slice(index)) ?? []));
  }
  return files;
}

export function templateTagRange(ctx: RuleContext, file: string, text: string): SourceRange {
  const start = Math.max(text.search(/<template[\s>]/), 0);
  return ctx.helpers.rangeFromOffsets(file, text, start, start + "<template".length);
}

export type ConfigFlag =
  | { state: "on"; file: string }
  | { state: "off"; file: string }
  | { state: "unknown"; reason: string };

/**
 * `app.<key>` as the app's nuxt.config files set it statically, the highest-priority layer first.
 * Undefined when no config sets it, so Nuxt's default applies.
 */
export function readAppConfigFlag(
  ctx: RuleContext,
  layers: NuxtAppSource[],
  key: "pageTransition" | "layoutTransition",
): ConfigFlag | undefined {
  for (const layer of layers) {
    const flag = readLayerConfigFlag(ctx, layer.root, key);
    if (flag) return flag;
  }
  const unread = unreadLayers(ctx, layers);
  if (unread) return { state: "unknown", reason: unread };
  return undefined;
}

/**
 * Why some layers of the app are missing from `layers`, or undefined when Doctor reads them all.
 * Without a Nuxt manifest Doctor only sees the root layer, so `extends` hides the others.
 */
export function unreadLayers(ctx: RuleContext, layers: NuxtAppSource[]): string | undefined {
  const projectApp = isProjectApp(ctx, layers);
  const known = projectApp ? (ctx.project.nuxt?.layers.length ?? 0) : 0;
  if (known > layers.length)
    return `${known - layers.length} Nuxt layer(s) of the app are outside the Doctor Run.`;
  if (layers.length !== 1 || (projectApp && ctx.project.nuxt?.manifest?.hasManifest))
    return undefined;
  const config = configFile(ctx, layers[0]!.root);
  if (config && /\bextends\s*:/.test(config.text))
    return `${displayPath(ctx, config.file)} extends layers Doctor cannot read without a Nuxt manifest.`;
  return undefined;
}

function configFile(ctx: RuleContext, root: string) {
  for (const name of NUXT_CONFIG_FILES) {
    const file = join(root, name);
    const text = ctx.fs.readText(file);
    if (text !== undefined) return { file, text };
  }
  return undefined;
}

function readLayerConfigFlag(
  ctx: RuleContext,
  root: string,
  key: "pageTransition" | "layoutTransition",
): ConfigFlag | undefined {
  const config = configFile(ctx, root);
  if (!config) return undefined;
  const { file, text } = config;
  const mentioned = new RegExp(`\\b${key}\\b`).test(text);
  const unknown = (why: string): ConfigFlag => ({
    state: "unknown",
    reason: `${displayPath(ctx, file)} ${why}`,
  });
  const program = parseScript(file, text) as AnyNode;
  const bindings = program ? topLevelBindings(program) : new Map();
  const object = program ? exportedConfigObject(program, bindings) : null;
  if (!object)
    return mentioned ? unknown(`sets app.${key} in a config Doctor cannot read.`) : undefined;
  for (const property of object.properties ?? []) {
    if (property.type !== "Property") {
      if (mentioned) return unknown(`spreads values that may set app.${key}.`);
      continue;
    }
    const name = propertyName(property);
    if (
      name &&
      (ENVIRONMENT_OVERRIDE_KEYS.has(name) || name === "$env") &&
      new RegExp(`\\b${key}\\b`).test(text.slice(property.start, property.end))
    )
      return unknown(`sets app.${key} for one environment only.`);
  }
  const appProperty = (object.properties ?? []).find(
    (property: AnyNode) => property.type === "Property" && propertyName(property) === "app",
  );
  if (!appProperty) return undefined;
  const app = objectExpression(appProperty.value, bindings);
  if (!app) return mentioned ? unknown(`computes app, which may set app.${key}.`) : undefined;
  let value: AnyNode;
  for (const property of app.properties ?? []) {
    if (property.type !== "Property") {
      if (mentioned) return unknown(`spreads values into app that may set ${key}.`);
      continue;
    }
    if (propertyName(property) === key) value = unwrap(property.value);
  }
  if (!value) return undefined;
  if (value.type === "ObjectExpression") return { state: "on", file };
  if (value.type === "Literal" && typeof value.value === "boolean")
    return { state: value.value ? "on" : "off", file };
  return unknown(`computes app.${key}.`);
}

export interface ParsedSfc {
  text: string;
  template: TemplateRootNode | null;
  /** `<script setup>` and `<script>` top-level statements. */
  script: AnyNode;
}

export async function readSfc(ctx: RuleContext, file: string): Promise<ParsedSfc | undefined> {
  const text = ctx.fs.readText(file);
  if (text === undefined) return undefined;
  const sfc = await parseSfcFile(file, text);
  return {
    text,
    template: sfc.getTemplateAst(),
    script: sfc.getScriptAst() as AnyNode,
  };
}

export type MetaFlag = "on" | "off" | "unknown" | undefined;

/** A `definePageMeta()` key as the page sets it statically; undefined when it does not set it. */
export function pageMetaFlag(script: AnyNode, key: string): MetaFlag {
  return pageMetaValue(script, key, transitionFlag);
}

export function transitionFlag(value: AnyNode): MetaFlag {
  if (value?.type === "ObjectExpression") return "on";
  if (value?.type === "Literal") {
    if (value.value === null) return undefined;
    if (typeof value.value === "boolean") return value.value ? "on" : "off";
  }
  return "unknown";
}

export function pageMetaValue<T>(
  script: AnyNode,
  key: string,
  read: (value: AnyNode) => T,
): T | "unknown" | undefined {
  let result: T | "unknown" | undefined;
  for (const statement of script?.body ?? []) {
    const call = unwrap(statement.type === "ExpressionStatement" ? statement.expression : null);
    if (call?.type !== "CallExpression" || call.callee?.name !== "definePageMeta") continue;
    const meta = unwrap(call.arguments?.[0]);
    if (meta?.type !== "ObjectExpression") return "unknown";
    for (const property of meta.properties ?? []) {
      if (property.type !== "Property" || propertyName(property) === null) result = "unknown";
      else if (propertyName(property) === key) result = read(unwrap(property.value));
    }
  }
  return result;
}

export type RootShape =
  | { kind: "single" }
  | { kind: "unknown" }
  | { kind: "multiple"; count: number; node: { start: number; end: number } }
  | { kind: "comment"; node: { start: number; end: number } }
  | { kind: "text"; node: { start: number; end: number } };

/**
 * How many nodes the template renders at its root, as Vue compiles it in development: a
 * `v-if`/`v-else-if`/`v-else` chain is one root, a root `v-for` or a `<template>` branch with
 * several children is a fragment, and comments stay in the output.
 */
export function templateRootShape(root: TemplateRootNode): RootShape {
  const roots: Array<{
    type: "element" | "slot" | "comment" | "text";
    start: number;
    end: number;
  }> = [];
  for (const node of templateRoots(root)) {
    if (node.type !== "element") {
      const { start, end } = node.node.loc;
      roots.push({ type: node.type, start: start.offset, end: end.offset });
      continue;
    }
    for (const branch of node.branches) {
      const loc = { start: branch.loc.start.offset, end: branch.loc.end.offset };
      if (findTemplateDirective(branch, "for")) return { kind: "multiple", count: 2, node: loc };
      if (branch.tagType === 3 && meaningfulChildren(branch) > 1)
        return { kind: "multiple", count: meaningfulChildren(branch), node: loc };
    }
    const [first] = node.branches;
    roots.push({
      type: node.branches.every((branch) => branch.tagType === 2) ? "slot" : "element",
      start: first!.loc.start.offset,
      end: first!.loc.end.offset,
    });
  }
  const [first, second] = roots;
  if (!first) return { kind: "unknown" };
  if (!second) {
    if (first.type === "element") return { kind: "single" };
    // A lone <slot> renders whatever its caller passes, which may be one element.
    if (first.type === "slot") return { kind: "unknown" };
    return first.type === "text" ? { kind: "text", node: first } : { kind: "comment", node: first };
  }
  const content = roots.filter((node) => node.type !== "comment");
  if (content.length === 1 && content[0]!.type === "slot") return { kind: "unknown" };
  if (content.length === 1 && content[0]!.type === "element")
    return { kind: "comment", node: roots.find((node) => node.type === "comment")! };
  return { kind: "multiple", count: roots.length, node: second };
}

function meaningfulChildren(element: TemplateElementNode): number {
  return element.children.filter(
    (child) => !(child.type === TemplateNodeType.TEXT && !child.content.trim()),
  ).length;
}

/**
 * Without a current Nuxt manifest, Doctor reads routes from the pages/ directory. Config that
 * changes which files are pages, such as `ignore`, `pages.pattern`, or `.nuxtignore`, makes that
 * reading unreliable.
 */
function scanIsReliable(ctx: RuleContext, layer: NuxtAppSource, kind: "pages" | "layouts") {
  if (ctx.fs.exists(join(layer.root, ".nuxtignore"))) return false;
  const text = configFile(ctx, layer.root)?.text ?? "";
  return (
    !/\b(?:ignore|ignorePrefix|dir|extensions)\s*['"]?\s*:/.test(text) &&
    (kind === "pages"
      ? !/\bpages\s*['"]?\s*:\s*(?!\s*true\b)|pages:(?:extend|resolved)/.test(text)
      : !/app:resolve|app:templates/.test(text))
  );
}

export function conventionalPagesDirectory(
  ctx: RuleContext,
  layers = nuxtLayerSources(ctx).find((app) => isProjectApp(ctx, app)),
): string | undefined {
  if (!layers || layers.length !== 1 || !isProjectApp(ctx, layers)) return undefined;
  const [layer] = layers;
  if (!layer) return undefined;
  if (layer.srcDir !== layer.root && layer.srcDir !== join(layer.root, "app")) return undefined;
  const preparedDir =
    ctx.project.nuxt?.manifest?.resolvedApp?.inputs?.pages?.directories[0]?.directory;
  if (preparedDir !== undefined && resolve(layer.root, preparedDir) !== join(layer.srcDir, "pages"))
    return undefined;
  const appDir = join(layer.root, "app");
  const appEntries = ctx.fs.readDir(appDir);
  if (!appEntries && ctx.fs.exists(appDir)) return undefined;
  const legacy = ["app.vue", "App.vue", "assets", "layouts", "middleware", "pages", "plugins"];
  const srcDir =
    appEntries &&
    (appEntries.some(
      ({ name }) => name !== "spa-loading-template.html" && !name.startsWith("router.options"),
    ) ||
      !legacy.some((name) => ctx.fs.exists(join(layer.root, name))))
      ? appDir
      : layer.root;
  const sourceEntries = srcDir === appDir ? appEntries : ctx.fs.readDir(srcDir);
  if (
    !sourceEntries ||
    [".nuxtignore", ".nuxtrc", "layers", "modules"].some((path) =>
      ctx.fs.exists(join(layer.root, path)),
    ) ||
    ctx.fs.exists(join(srcDir, "modules")) ||
    sourceEntries.some((entry) => entry.name.startsWith("router.options."))
  )
    return undefined;
  const config = configFile(ctx, layer.root);
  if (config) {
    const program = parseScript(config.file, config.text) as AnyNode;
    if (
      !program ||
      program.body.some((statement: AnyNode) => statement.type !== "ExportDefaultDeclaration")
    )
      return undefined;
    const object = exportedConfigObject(program, new Map());
    if (
      !object ||
      object.properties.some((property: AnyNode) => {
        if (property.type !== "Property" || property.computed || property.kind !== "init")
          return true;
        const name = propertyName(property);
        return (
          !name ||
          name.startsWith("$") ||
          /^(?:extends|theme|modules|_modules|hooks|router|rootDir|srcDir|dir|pagesDir|ignore|ignorePrefix|extensions|future)$/.test(
            name,
          ) ||
          (name === "alias" && mayAliasPages(property.value)) ||
          (name === "pages" && unwrap(property.value)?.value !== true)
        );
      })
    )
      return undefined;
  } else if (NUXT_CONFIG_FILES.some((name) => ctx.fs.exists(join(layer.root, name)))) {
    return undefined;
  }
  return join(srcDir, "pages");
}

function mayAliasPages(value: AnyNode): boolean {
  const aliases = unwrap(value);
  return (
    aliases?.type !== "ObjectExpression" ||
    aliases.properties.some((property: AnyNode) => {
      const name = propertyName(property);
      return property.type !== "Property" || property.computed || !name || name === "pages";
    })
  );
}

export function preparedPagesSourceChanged(ctx: RuleContext, conventionalDir: string | undefined) {
  const preparedDir =
    ctx.project.nuxt?.manifest?.resolvedApp?.inputs?.pages?.directories[0]?.directory;
  return (
    conventionalDir !== undefined &&
    preparedDir !== undefined &&
    resolve(nuxtInventoryRoot(ctx), preparedDir) !== conventionalDir
  );
}

function isProjectApp(ctx: RuleContext, layers: NuxtAppSource[]): boolean {
  return layers[0]?.root === nuxtInventoryRoot(ctx);
}

function currentManifest(ctx: RuleContext, layers: NuxtAppSource[], kind: NuxtAppInventoryKind) {
  const manifest = ctx.project.nuxt?.manifest;
  return manifest?.resolvedAppCurrent?.[kind] && isProjectApp(ctx, layers) ? manifest : undefined;
}

export interface PageRoute {
  file: string;
  parent: string | null;
  path?: string;
  fullPath?: string;
}

function staticPagesDisable(ctx: RuleContext, layer: NuxtAppSource): boolean | "unknown" {
  const config = configFile(ctx, layer.root);
  if (!config || /pages:(?:extend|resolved)/.test(config.text)) return false;
  const program = parseScript(config.file, config.text) as AnyNode;
  if (!program) return false;
  const object = exportedConfigObject(program, new Map());
  const properties = object?.properties;
  if (
    !properties ||
    properties.some((property: AnyNode) => {
      const name = propertyName(property);
      return (
        property.type !== "Property" ||
        property.kind !== "init" ||
        !name ||
        name.startsWith("$") ||
        name === "router"
      );
    })
  )
    return false;
  const pages = unwrap(
    properties.findLast((property: AnyNode) => propertyName(property) === "pages")?.value,
  );
  let enabled = pages;
  if (pages?.type === "ObjectExpression") {
    if (
      pages.properties.some(
        (property: AnyNode) =>
          property.type !== "Property" || property.kind !== "init" || !propertyName(property),
      )
    )
      return false;
    enabled = unwrap(
      pages.properties.findLast((property: AnyNode) => propertyName(property) === "enabled")?.value,
    );
  }
  if (enabled?.type !== "Literal" || enabled.value !== false) return false;
  const hooks = properties.findLast((property: AnyNode) => propertyName(property) === "hooks");
  if (hooks) {
    const value = unwrap(hooks.value);
    if (value?.type !== "ObjectExpression" || value.properties.length) return "unknown";
  }
  return true;
}

export function pageRoutes(ctx: RuleContext, layers: NuxtAppSource[], sources: readonly string[]) {
  const prepared = isProjectApp(ctx, layers) ? ctx.project.nuxt?.manifest?.resolvedApp : undefined;
  const conventionalDir = prepared && conventionalPagesDirectory(ctx, layers);
  const manifest = preparedPagesSourceChanged(ctx, conventionalDir)
    ? undefined
    : currentManifest(ctx, layers, "pages");
  const pages = manifest?.pages ?? [];
  if (manifest?.resolvedApp?.pagesResolved) {
    const root = nuxtInventoryRoot(ctx);
    return pages.flatMap((page): PageRoute[] =>
      page.file
        ? [
            {
              file: resolve(root, page.file),
              parent: page.parentFile ? resolve(root, page.parentFile) : null,
              path: page.path,
              fullPath: page.fullPath,
            },
          ]
        : [],
    );
  }
  if (pages.length || layers.length !== 1 || unreadLayers(ctx, layers)) return undefined;
  const layer = layers[0]!;
  const disabled = staticPagesDisable(ctx, layer);
  if (disabled === true) return [];
  if (disabled === "unknown") return undefined;
  if (!scanIsReliable(ctx, layer, "pages")) return undefined;
  const dir = prepared ? conventionalDir : join(layer.srcDir, "pages");
  if (!dir) return undefined;
  const files = sources.filter((file) => isInsideDir(file, dir) && isScannedNuxtFile(file));
  const stems = new Map(files.map((file) => [file.replace(/\.[^.]+$/, ""), file]));
  return files.map((file): PageRoute => {
    let folder = dirname(file);
    while (folder !== dir) {
      const parent = stems.get(folder);
      if (parent)
        return {
          file,
          parent,
          path: folder === dirname(file) && basename(file).startsWith("index.") ? "" : undefined,
        };
      folder = dirname(folder);
    }
    return { file, parent: null };
  });
}

export function registeredLayouts(
  ctx: RuleContext,
  layers: NuxtAppSource[],
  sources: readonly string[],
) {
  const app = currentManifest(ctx, layers, "layouts")?.resolvedApp;
  if (app)
    return Object.entries(app.layouts).map(([name, file]) => ({
      name,
      file: resolve(nuxtInventoryRoot(ctx), file),
    }));
  if (
    layers.length !== 1 ||
    unreadLayers(ctx, layers) ||
    !scanIsReliable(ctx, layers[0]!, "layouts")
  )
    return undefined;
  const dir = join(layers[0]!.srcDir, "layouts");
  const files = sources.filter((file) => isInsideDir(file, dir) && isScannedNuxtFile(file));
  return files
    .filter((file) => !/^index\.[^.]+$/.test(relative(dir, file)))
    .map((file) => ({
      name: relative(dir, file)
        .replace(/\.[^.]+$/, "")
        .replace(/\/index$/i, "")
        .replace(/([a-z\d])([A-Z])/g, "$1-$2")
        .replace(/[/_]/g, "-")
        .toLowerCase(),
      file,
    }));
}

/** Undefined is Nuxt's built-in app; null means the selected app cannot be established. */
export function mainApp(ctx: RuleContext, layers: NuxtAppSource[]): string | null | undefined {
  const component = currentManifest(ctx, layers, "mainComponent")?.resolvedApp?.mainComponent;
  if (component) {
    const file = resolve(nuxtInventoryRoot(ctx), component);
    if (/\/nuxt\/dist\/(?:pages\/runtime\/app|app\/components\/welcome)\.vue$/.test(file))
      return undefined;
    return file;
  }
  if (
    layers.some((layer) =>
      /app:resolve|app:templates/.test(configFile(ctx, layer.root)?.text ?? ""),
    )
  )
    return null;
  const owners = layers.map((layer) =>
    (ctx.fs.readDir(layer.srcDir) ?? []).filter(
      (entry) => entry.isFile() && /^[Aa]pp\.(?:vue|[cm]?[jt]sx?)$/.test(entry.name),
    ),
  );
  const index = owners.findIndex((entries) => entries.length);
  if (index !== 0 && unreadLayers(ctx, layers)) return null;
  if (index < 0) return undefined;
  const files = owners[index]!;
  return files.length === 1 ? join(layers[index]!.srcDir, files[0]!.name) : null;
}
