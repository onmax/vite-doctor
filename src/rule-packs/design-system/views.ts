import { basename, join, relative } from "pathe";
import type {
  ComponentNode,
  ComponentSlotOutletFact,
  ComponentUsageEdge,
  ComponentUsageFact,
  ComponentUsageGraph,
  RuleContext,
  SourceRange,
} from "../../core/index.js";
import { bindingMaySet, camelize } from "../../core/internal/component-facts.js";
import { parseScript } from "../../core/internal/script.js";
import { TemplateNodeType, walkTemplate } from "../../core/internal/template.js";
import { walkScriptLocal } from "../../core/rule-authoring.js";
import type { NuxtAppSource } from "../nuxt/rules/nuxt/file-classification.js";
import { propertyName, unwrap } from "../nuxt/rules/nuxt/nuxt-config-ast.js";
import {
  mainApp,
  nuxtLayerSources,
  type PageRoute,
  pageMetaValue,
  pageRoutes,
  pascalTag,
  readSfc,
  registeredLayouts,
} from "../nuxt/rules/nuxt/page-structure.js";
import { type ComponentNames, componentNames, pascalCase } from "./contracts.js";

/**
 * A View: everything one route renders at once in a Nuxt app. The main app, the route's layout,
 * its parent pages, and the page itself, each expanded through the components they render.
 */
export interface View {
  /** The route, such as `/settings/profile`, or the page file when Doctor cannot name it. */
  route: string;
  /** The page file the route renders. */
  page: string;
  layout?: string;
  /** The files that make up the view, in document order: app, layout, parent pages, page. */
  roots: ViewRoot[];
}

export interface ViewRoot extends RenderPath {
  file: string;
  kind: "app" | "layout" | "page";
}

interface RenderStep {
  file: string;
  range: SourceRange;
  tag: string;
}

interface RenderPath {
  via: RenderStep[];
  certainty: Certainty;
}

/** A component usage that renders every time its view does. */
export interface RenderedUsage extends RenderPath {
  file: string;
  /** Index into the file's `usages`. */
  index: number;
  usage: ComponentUsageFact;
  edge: ComponentUsageEdge;
  /** The SFC the usage renders, when Doctor resolved it or Nuxt names it. */
  target?: string | null;
}

export type Certainty = "proven" | "heuristic";

const PAGE_OUTLETS = new Set(["NuxtPage", "RouterView"]);
// Built-ins that render their content somewhere else, or something other than what is written.
const DETACHED = new Set(["teleport", "component"]);
// Components that keep their content closed until the user opens them.
const OVERLAY = /Dialog|Modal|Drawer|Sheet|Slideover|Popover|Tooltip|Menu/;

const DIRECT: RenderPath = { via: [], certainty: "proven" };

/**
 * The component usage graph with each usage's SFC: the graph's edge target, else the SFC Nuxt
 * registers under the tag. `null` when the tag may name a project SFC Doctor cannot pin down.
 */
export interface ViewGraph {
  graph: ComponentUsageGraph;
  target(edge: ComponentUsageEdge): string | null | undefined;
  outlet(edge: ComponentUsageEdge): string | undefined;
  /** Rendered usages per root file, shared by the Views that render it. */
  rendered: Map<string, RenderedUsage[]>;
}

export function viewGraph(ctx: RuleContext, graph: ComponentUsageGraph): ViewGraph {
  const names = componentNames(ctx.project, graph);
  // Without Nuxt's registry, any SFC under components/ may be auto-imported under a prefixed name.
  const guessable = new Set<string>();
  if (!names.registered.size)
    for (const node of graph.components.values())
      if (node.sourceKind !== "module" && /(?:^|\/)components\//.test(node.relativePath))
        guessable.add(pascalCase(basename(node.file).replace(/\.vue$/, "")));
  return {
    graph,
    rendered: new Map(),
    target(edge) {
      if (edge.resolvedBy === "import") return edge.target;
      const node = graph.components.get(edge.from);
      if (node && (tagBinding(node, edge.usage) || edge.usage.tag.includes("."))) return null;
      if (edge.target) return edge.target;
      const tag = pascalTag(edge.usage.tag);
      const named = registered(names, tag);
      if (named) {
        if (graph.components.has(named)) return named;
        return /(?:^|\/)node_modules\//.test(named) ? undefined : null;
      }
      for (let index = 0; index < tag.length; index++)
        if ((!index || /[A-Z]/.test(tag[index]!)) && guessable.has(tag.slice(index))) return null;
      return undefined;
    },
    outlet(edge) {
      const node = graph.components.get(edge.from);
      const binding = node && tagBinding(node, edge.usage);
      if (binding) {
        if (typeof binding === "string") return undefined;
        if (binding.source === "vue-router" && binding.imported === "RouterView")
          return "RouterView";
        if (
          binding.source === "#components" &&
          ["NuxtPage", "NuxtLayout"].includes(binding.imported) &&
          !edge.target
        )
          return binding.imported;
        return undefined;
      }
      const tag = pascalTag(edge.usage.tag);
      return (tag === "NuxtLayout" || PAGE_OUTLETS.has(tag)) && this.target(edge) === undefined
        ? tag
        : undefined;
    },
  };
}

function tagBinding(node: ComponentNode, usage: ComponentUsageFact) {
  const tag = usage.tag.split(".")[0]!;
  const camel = camelize(tag);
  for (const name of new Set([tag, camel, pascalCase(tag)])) {
    if (usage.scope.includes(name) || node.facts.setupBindings.includes(name)) return name;
    const imported = node.facts.imports.find(({ local }) => local === name);
    if (imported) return imported;
  }
  return node.facts.registeredComponentNames.find((name) => pascalCase(name) === pascalCase(tag));
}

function registered(names: ComponentNames, tag: string): string | undefined {
  return names.registered.get(tag) ?? names.nuxtDefault.get(tag);
}

/**
 * Every View of the Doctor Run's Nuxt apps that Doctor can establish. A route whose view depends
 * on something Doctor cannot read statically, such as a computed layout, has no View. Projects
 * without Nuxt have no Views: Doctor cannot tell which components render together without routes.
 */
export async function projectViews(ctx: RuleContext, resolved: ViewGraph): Promise<View[]> {
  const { graph } = resolved;
  if (!ctx.project.nuxt) return [];
  const sources = await ctx.inventory.sourcePaths();
  const views: View[] = [];
  for (const [index, layers] of nuxtLayerSources(ctx).entries()) {
    const routes = pageRoutes(ctx, layers, sources);
    const app = mainApp(ctx, layers);
    if (!routes || app === null || (app && !graph.components.has(app))) continue;
    const main = index === 0 && !!ctx.project.nuxt.layers?.length;
    const runtime = await runtimeLayouts(ctx, layers, main, sources, routes);
    if (runtime === "everywhere") continue;
    const layouts = registeredLayouts(ctx, layers, sources);
    const byFile = new Map<string, PageRoute | null>();
    for (const route of routes) byFile.set(route.file, byFile.has(route.file) ? null : route);
    const defaultParents = new Set(
      routes.filter((route) => route.path === "").map((route) => route.parent),
    );
    for (const route of routes) {
      if (defaultParents.has(route.file)) continue;
      const chain = routeChain(route, byFile);
      if (!chain?.every(({ file }) => graph.components.has(file))) continue;
      if (chain.some(({ file }) => runtime.pages.has(file))) continue;
      let layout: LayoutChoice | "unknown" | undefined;
      let path: string | undefined = "";
      for (const { file, parent, path: preparedPath } of chain) {
        const sfc = await readSfc(ctx, file);
        if (!sfc) {
          layout = "unknown";
          path = undefined;
        } else {
          layout = pageMetaValue(sfc.script, "layout", staticLayout) ?? layout;
          const override = pageMetaValue(sfc.script, "path", staticPath);
          const local =
            override === "unknown"
              ? undefined
              : (override?.path ?? preparedPath ?? routeSegment(layers, file, parent));
          path = local?.startsWith("/")
            ? local
            : local !== undefined && path !== undefined
              ? `${path.replace(/\/$/, "")}/${local}`.replace(/(.)\/$/, "$1")
              : undefined;
        }
      }
      if (layout === "unknown") continue;
      const label = route.fullPath ?? path ?? relative(ctx.project.root, route.file);
      if (runtime.patterns.some((pattern) => mayMatch(pattern, label))) continue;
      const name = layout?.name ?? "default";
      const layoutFile =
        name === false ? undefined : layouts?.find((entry) => entry.name === name)?.file;
      if (layoutFile === undefined && name !== false && !layouts) continue;
      if (layoutFile && !graph.components.has(layoutFile)) continue;
      const roots = viewRoots(resolved, app, layoutFile, chain);
      if (roots)
        views.push({
          route: label,
          page: route.file,
          layout: layoutFile,
          roots,
        });
    }
  }
  return views;
}

/** Where the app may pick a layout at runtime, outside `definePageMeta`. */
interface RuntimeLayouts {
  /** Pages whose own `defineRouteRules` may set `appLayout`. */
  pages: Set<string>;
  /** Route rule patterns that set `appLayout`. */
  patterns: string[];
}

const SET_PAGE_LAYOUT = /\bsetPageLayout\b/;
const DEFINE_ROUTE_RULES = /\bdefineRouteRules\b/;
const NUXT_CONFIGS = ["ts", "mts", "js", "mjs", "cjs", "cts"].map((ext) => `nuxt.config.${ext}`);

/**
 * `setPageLayout()` can switch any route's layout, so a call in the app's sources, or in a file no
 * app owns, leaves the app without Views. An `appLayout` route rule removes the routes it may match
 * when Nuxt's manifest records the rules, and the whole app when only the config text shows it.
 */
async function runtimeLayouts(
  ctx: RuleContext,
  layers: NuxtAppSource[],
  main: boolean,
  sources: readonly string[],
  routes: PageRoute[],
): Promise<RuntimeLayouts | "everywhere"> {
  const owners = nuxtLayerSources(ctx).flat();
  const owns = (file: string) => layers.some(({ root }) => file.startsWith(`${root}/`));
  const pages = new Set(routes.map(({ file }) => file));
  const found: RuntimeLayouts = { pages: new Set(), patterns: [] };
  for (const file of sources) {
    if (!owns(file) && owners.some(({ root }) => file.startsWith(`${root}/`))) continue;
    if (/\.d\.[cm]?ts$/.test(file)) continue;
    const text = ctx.fs.readText(file);
    if (!text) continue;
    if (!SET_PAGE_LAYOUT.test(text) && !DEFINE_ROUTE_RULES.test(text)) continue;
    const sfc = file.endsWith(".vue") ? await readSfc(ctx, file) : undefined;
    const script = file.endsWith(".vue") ? sfc?.script : parseScript(file, text);
    let switches = callsApi(script, "setPageLayout");
    if (sfc?.template && !switches)
      walkTemplate(sfc.template, (node) => {
        if (switches) return;
        const expression =
          node.type === TemplateNodeType.DIRECTIVE
            ? node.exp?.content
            : node.type === TemplateNodeType.INTERPOLATION
              ? node.content.content
              : undefined;
        if (expression && SET_PAGE_LAYOUT.test(expression))
          switches = callsApi(parseScript("template.ts", expression), "setPageLayout");
      });
    if (switches) return "everywhere";
    if (
      NUXT_CONFIGS.includes(basename(file)) ||
      !callsApi(script, "defineRouteRules", maySetRouteLayout)
    )
      continue;
    if (!owns(file) || !pages.has(file)) return "everywhere";
    found.pages.add(file);
  }
  const manifest = main ? ctx.project.nuxt?.manifest : undefined;
  const recorded = manifest?.hasManifest && manifest.isCurrent;
  for (const { root } of layers)
    for (const name of NUXT_CONFIGS)
      if (!recorded) {
        const file = join(root, name);
        const text = ctx.fs.readText(file);
        if (!text || !/\bappLayout\b/.test(text)) continue;
        const ast = parseScript(file, text);
        if (hasProperty(ast, "routeRules") && hasProperty(ast, "appLayout")) return "everywhere";
      }
  if (recorded)
    for (const rules of [ctx.project.nuxt?.routeRules, manifest.resolvedRouteRules])
      for (const [pattern, rule] of Object.entries(rules ?? {}))
        if (rule && typeof rule === "object" && "appLayout" in rule) found.patterns.push(pattern);
  return found;
}

function hasProperty(ast: unknown, name: string): boolean {
  let found = false;
  walkScriptLocal(ast, (node) => {
    if (node.type === "Property" && propertyName(node) === name) found = true;
  });
  return found;
}

function maySetRouteLayout(argument: unknown): boolean {
  const value = unwrap(argument);
  return (
    value?.type !== "ObjectExpression" ||
    value.properties.some((property: { type: string }) => {
      if (property.type !== "Property") return true;
      const key = propertyName(property);
      return key === null || key === "appLayout";
    })
  );
}

function callsApi(ast: unknown, name: string, matches?: (argument: unknown) => boolean): boolean {
  let found = false;
  const names = new Set([name]);
  walkScriptLocal(ast, (node) => {
    if (node.type === "ImportSpecifier" && node.imported?.name === name) names.add(node.local.name);
  });
  walkScriptLocal(ast, (node) => {
    if (found || node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    const invoked =
      callee?.type === "Identifier"
        ? names.has(callee.name)
        : callee?.type === "MemberExpression" &&
          (callee.computed ? callee.property?.value === name : callee.property?.name === name);
    if (!invoked) return;
    found = matches?.(node.arguments?.[0]) ?? true;
  });
  return found;
}

/** Whether a route rule pattern may match some URL of a view's route, such as `/users/:id()`. */
function mayMatch(pattern: string, route: string): boolean {
  const want = pattern.split("/").filter(Boolean);
  const have = route.split("/").filter(Boolean);
  if (!route.startsWith("/") || have.some((segment) => /[:*([]/.test(segment))) return true;
  for (const [index, segment] of want.entries()) {
    if (segment.startsWith("**")) return true;
    if (index >= have.length) return false;
    if (segment !== "*" && !segment.startsWith(":") && segment !== have[index]) return false;
  }
  return want.length === have.length;
}

/** A layout a page names: a layout name, or `false` for none. */
interface LayoutChoice {
  name: string | false;
}

function staticLayout(value: unknown): LayoutChoice | "unknown" | undefined {
  const node = unwrap(value) as { type?: string; value?: unknown } | undefined;
  if (node?.type !== "Literal") return "unknown";
  if (node.value === null) return undefined;
  return typeof node.value === "string" || node.value === false ? { name: node.value } : "unknown";
}

function staticPath(value: unknown): { path: string } | "unknown" {
  const node = unwrap(value) as { type?: string; value?: unknown } | undefined;
  return node?.type === "Literal" && typeof node.value === "string"
    ? { path: node.value }
    : "unknown";
}

function routeChain(route: PageRoute, byFile: Map<string, PageRoute | null>) {
  const chain = [route];
  const seen = new Set([route.file]);
  while (route.parent) {
    const parent = byFile.get(route.parent);
    if (!parent || seen.has(parent.file)) return undefined;
    seen.add(parent.file);
    chain.unshift(parent);
    route = parent;
  }
  return chain;
}

function routeSegment(layers: NuxtAppSource[], page: string, parent: string | null | undefined) {
  for (const layer of layers) {
    const dir = parent?.replace(/\.[^./]+$/, "") ?? join(layer.srcDir, "pages");
    if (!page.startsWith(`${dir}/`)) continue;
    const segments = relative(dir, page)
      .replace(/\.[^./]+$/, "")
      .split("/");
    if (segments.at(-1) === "index") segments.pop();
    if (segments.some((segment) => segment === "index" || /[[\]]/.test(segment))) return undefined;
    return segments.join("/");
  }
  return undefined;
}

/**
 * The files a route renders and how certain Doctor is that each renders, or undefined when the
 * app picks its layout in a way Doctor cannot read.
 */
function viewRoots(
  graph: ViewGraph,
  app: string | undefined,
  layout: string | undefined,
  chain: PageRoute[],
): ViewRoot[] | undefined {
  const roots: ViewRoot[] = [];
  let pages = layout ? slotPlacement(graph, layout, "default", layout, new Set()) : [DIRECT];
  if (app) {
    roots.push({ file: app, kind: "app", ...DIRECT });
    const rendered = renderedUsages(graph, app, layout);
    const layouts = rendered.filter(({ edge }) => graph.outlet(edge) === "NuxtLayout");
    if (layouts.some(({ usage }) => choosesLayout(usage))) return undefined;
    if (layout)
      for (const mount of layouts)
        roots.push({ file: layout, kind: "layout", ...throughUsage(mount) });
    pages = pageOutlets(graph, rendered);
  } else if (layout) {
    roots.push({ file: layout, kind: "layout", ...DIRECT });
  }
  for (const [index, route] of chain.entries()) {
    if (!pages.length) break;
    for (const path of pages) roots.push({ file: route.file, kind: "page", ...path });
    if (index === chain.length - 1) break;
    const outlets = pageOutlets(graph, renderedUsages(graph, route.file, layout));
    pages = pages.flatMap((parent) => outlets.map((outlet) => joinPaths(parent, outlet)));
  }
  return roots;
}

function pageOutlets(graph: ViewGraph, rendered: RenderedUsage[]): RenderPath[] {
  return rendered
    .filter(
      ({ edge, usage }) =>
        PAGE_OUTLETS.has(graph.outlet(edge) ?? "") &&
        !usage.hasSlotContent &&
        !usage.directives.includes("slot") &&
        !mayPass(usage, ["name", "route"]),
    )
    .map(throughUsage);
}

function mayPass(usage: ComponentUsageFact, names: readonly string[]): boolean {
  return (
    usage.spreads.some(
      ({ directive, expression }) => directive === "bind" && bindingMaySet(expression, names),
    ) ||
    usage.attributes.some(({ name }) => names.includes(name)) ||
    usage.bindings.some(({ vnodeKey }) => names.includes(vnodeKey))
  );
}

// `<NuxtLayout name>` or `fallback` overrides the layout the page asks for.
function choosesLayout(usage: ComponentUsageFact): boolean {
  return mayPass(usage, ["name", "fallback"]);
}

/** Every component usage that renders whenever the view does, in document order. */
export function viewUsages(graph: ViewGraph, view: View): RenderedUsage[] {
  const { layout } = view;
  return view.roots.flatMap((root) => {
    const key = `${root.file}\0${layout ?? ""}`;
    let usages = graph.rendered.get(key);
    if (!usages) graph.rendered.set(key, (usages = renderedUsages(graph, root.file, layout)));
    return usages.map((usage) => ({ ...usage, ...joinPaths(root, usage) }));
  });
}

/**
 * The usages `file` renders every time it renders, expanded through the SFCs they resolve to.
 * `layout` is the layout `<NuxtLayout>` renders, whose default `<slot>` receives its content.
 */
function renderedUsages(
  views: ViewGraph,
  file: string,
  layout: string | undefined,
): RenderedUsage[] {
  const out: RenderedUsage[] = [];
  const expand = (node: ComponentNode, path: RenderPath, ancestors: Set<string>) => {
    for (const [index, usage] of node.facts.usages.entries()) {
      const edge = node.renders[index]!;
      const target = views.target(edge);
      for (const placed of placement(views, node, usage, layout, new Set())) {
        const rendered = {
          file: node.file,
          index,
          usage,
          edge,
          target,
          ...joinPaths(path, placed),
        };
        out.push(rendered);
        const child = target && views.graph.components.get(target);
        if (
          child &&
          !OVERLAY.test(pascalTag(usage.tag)) &&
          !OVERLAY.test(basename(child.file, ".vue")) &&
          !ancestors.has(child.file)
        )
          expand(child, throughUsage(rendered), new Set(ancestors).add(child.file));
      }
    }
  };
  const node = views.graph.components.get(file);
  if (node) expand(node, DIRECT, new Set([file]));
  return out;
}

/**
 * Whether a usage or `<slot>` outlet renders every time its SFC does: not conditional, not in a
 * `v-for`, not detached, and, inside another component's slot, passed through a slot outlet that
 * renders every time too.
 */
function placement(
  views: ViewGraph,
  node: ComponentNode,
  item: ComponentUsageFact | ComponentSlotOutletFact,
  layout: string | undefined,
  visiting: Set<string>,
): RenderPath[] {
  if (item.conditional || item.inFor) return [];
  if (item.builtInHosts.some((tag) => DETACHED.has(tag.replaceAll("-", "").toLowerCase())))
    return [];
  if (!item.host) return [DIRECT];
  const { slot } = item.host;
  const host = node.facts.usages[item.host.usage];
  const edge = node.renders[item.host.usage];
  if (!host || !edge || slot === null) return [];
  const tag = pascalTag(host.tag);
  const target = views.target(edge);
  if (OVERLAY.test(tag) || (target && OVERLAY.test(basename(target, ".vue")))) return [];
  const outer = placement(views, node, host, layout, visiting);
  if (!outer.length) return [];
  const outlet = views.outlet(edge);
  if (outlet && PAGE_OUTLETS.has(outlet)) return [];
  let inner: RenderPath[];
  if (outlet === "NuxtLayout") {
    if (slot !== "default" || choosesLayout(host)) return [];
    inner = layout ? slotPlacement(views, layout, slot, layout, visiting) : [DIRECT];
  } else if (target === null) return [];
  else if (target) inner = slotPlacement(views, target, slot, layout, visiting);
  else inner = slot === "default" ? [{ via: [], certainty: "heuristic" }] : [];
  return outer.flatMap((path) =>
    inner.map((outletPath) =>
      joinPaths(path, {
        ...outletPath,
        via: [{ file: node.file, range: host.range, tag: host.tag }, ...outletPath.via],
      }),
    ),
  );
}

function slotPlacement(
  views: ViewGraph,
  file: string,
  slot: string,
  layout: string | undefined,
  visiting: Set<string>,
): RenderPath[] {
  const key = `${file}#${slot}`;
  const node = views.graph.components.get(file);
  if (!node || visiting.has(key)) return [];
  const next = new Set(visiting).add(key);
  return node.facts.slotOutlets
    .filter((outlet) => outlet.name === slot)
    .flatMap((outlet) =>
      placement(views, node, outlet, layout, next).map((path) => ({
        ...path,
        via: [...path.via, { file, range: outlet.range, tag: "slot" }],
      })),
    );
}

function joinPaths(outer: RenderPath, inner: RenderPath): RenderPath {
  return {
    via: [...outer.via, ...inner.via],
    certainty:
      outer.certainty === "heuristic" || inner.certainty === "heuristic" ? "heuristic" : "proven",
  };
}

function throughUsage({ via, file, usage, certainty }: RenderedUsage): RenderPath {
  return { certainty, via: [...via, { file, range: usage.range, tag: usage.tag }] };
}
