import { basename, join, relative } from "pathe";
import type {
  ComponentNode,
  ComponentSlotOutletFact,
  ComponentUsageEdge,
  ComponentUsageFact,
  ComponentUsageGraph,
  RuleContext,
} from "../../core/index.js";
import type { NuxtAppSource } from "../nuxt/rules/nuxt/file-classification.js";
import { unwrap } from "../nuxt/rules/nuxt/nuxt-config-ast.js";
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
  /** The files that make up the view, in document order: app, layout, parent pages, page. */
  roots: ViewRoot[];
}

export interface ViewRoot {
  file: string;
  kind: "app" | "layout" | "page";
  /** `heuristic` when Doctor assumed a package component renders its default slot to reach it. */
  certainty: Certainty;
}

/** A component usage that renders every time its view does. */
export interface RenderedUsage {
  file: string;
  /** Index into the file's `usages`. */
  index: number;
  usage: ComponentUsageFact;
  edge: ComponentUsageEdge;
  /** The SFC the usage renders, when Doctor resolved it or Nuxt names it. */
  target?: string;
  /** The component usages that render `file` inside the view, outermost first. */
  via: ComponentUsageEdge[];
  certainty: Certainty;
}

export type Certainty = "proven" | "heuristic";

const PAGE_OUTLETS = new Set(["NuxtPage", "RouterView"]);
// Built-ins that render their content somewhere else, or something other than what is written.
const DETACHED = new Set(["teleport", "component"]);
// Components that keep their content closed until the user opens them.
const OVERLAY = /Dialog|Modal|Drawer|Sheet|Slideover|Popover|Tooltip|Menu/;

type Placement = Certainty | undefined;

/**
 * The component usage graph with each usage's SFC: the graph's edge target, else the SFC Nuxt
 * registers under the tag. `null` when the tag may name a project SFC Doctor cannot pin down.
 */
export interface ViewGraph {
  graph: ComponentUsageGraph;
  target(edge: ComponentUsageEdge): string | null | undefined;
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
  };
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
  for (const layers of nuxtLayerSources(ctx)) {
    const routes = pageRoutes(ctx, layers, sources);
    const app = mainApp(ctx, layers);
    if (!routes || app === null || (app && !graph.components.has(app))) continue;
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
      let layout: LayoutChoice | "unknown" | undefined;
      for (const { file } of chain) {
        const sfc = await readSfc(ctx, file);
        if (!sfc) layout = "unknown";
        else layout = pageMetaValue(sfc.script, "layout", staticLayout) ?? layout;
      }
      if (layout === "unknown") continue;
      const name = layout?.name ?? "default";
      const layoutFile =
        name === false ? undefined : layouts?.find((entry) => entry.name === name)?.file;
      if (layoutFile === undefined && name !== false && !layouts) continue;
      if (layoutFile && !graph.components.has(layoutFile)) continue;
      const roots = viewRoots(resolved, app, layoutFile, chain);
      if (roots)
        views.push({
          route: route.fullPath ?? routeName(ctx, layers, route.file),
          page: route.file,
          roots,
        });
    }
  }
  return views;
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

function routeName(ctx: RuleContext, layers: NuxtAppSource[], page: string): string {
  for (const layer of layers) {
    const dir = join(layer.srcDir, "pages");
    if (!page.startsWith(`${dir}/`)) continue;
    const segments = relative(dir, page)
      .replace(/\.[^./]+$/, "")
      .split("/")
      .filter((segment) => segment !== "index");
    return `/${segments.join("/")}`;
  }
  return relative(ctx.project.root, page);
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
  let pageCertainty: Placement = "proven";
  let layoutCertainty: Placement = layout ? "proven" : undefined;
  if (app) {
    roots.push({ file: app, kind: "app", certainty: "proven" });
    const rendered = renderedUsages(graph, app, "proven", layout);
    const layouts = rendered.filter(({ usage }) => pascalTag(usage.tag) === "NuxtLayout");
    if (layouts.some(({ usage }) => choosesLayout(usage))) return undefined;
    layoutCertainty = layout ? strongest(layouts.map(({ certainty }) => certainty)) : undefined;
    pageCertainty = strongest(
      rendered
        .filter(({ usage }) => PAGE_OUTLETS.has(pascalTag(usage.tag)))
        .map((r) => r.certainty),
    );
  }
  if (layout && layoutCertainty)
    roots.push({ file: layout, kind: "layout", certainty: layoutCertainty });
  for (const [index, route] of chain.entries()) {
    if (!pageCertainty) break;
    roots.push({ file: route.file, kind: "page", certainty: pageCertainty });
    if (index === chain.length - 1) break;
    const outlets = renderedUsages(graph, route.file, pageCertainty, layout).filter(({ usage }) =>
      PAGE_OUTLETS.has(pascalTag(usage.tag)),
    );
    pageCertainty = strongest(outlets.map(({ certainty }) => certainty));
  }
  return roots;
}

// `<NuxtLayout name>` or `fallback` overrides the layout the page asks for.
function choosesLayout(usage: ComponentUsageFact): boolean {
  return (
    usage.spreads.some((spread) => spread.directive === "bind") ||
    [...usage.attributes, ...usage.bindings].some(
      ({ name }) => name === "name" || name === "fallback",
    )
  );
}

/** Every component usage that renders whenever the view does, in document order. */
export function viewUsages(graph: ViewGraph, view: View): RenderedUsage[] {
  const layout = view.roots.find((root) => root.kind === "layout")?.file;
  return view.roots.flatMap((root) => {
    const key = `${root.file}\0${root.certainty}\0${layout ?? ""}`;
    let usages = graph.rendered.get(key);
    if (!usages)
      graph.rendered.set(key, (usages = renderedUsages(graph, root.file, root.certainty, layout)));
    return usages;
  });
}

/**
 * The usages `file` renders every time it renders, expanded through the SFCs they resolve to.
 * `layout` is the layout `<NuxtLayout>` renders, whose default `<slot>` receives its content.
 */
function renderedUsages(
  views: ViewGraph,
  file: string,
  certainty: Certainty,
  layout: string | undefined,
): RenderedUsage[] {
  const out: RenderedUsage[] = [];
  const expand = (node: ComponentNode, via: ComponentUsageEdge[], inherited: Certainty) => {
    for (const [index, usage] of node.facts.usages.entries()) {
      const placed = placement(views, node, usage, layout, new Set());
      if (!placed) continue;
      const edge = node.renders[index]!;
      const combined = weaker(inherited, placed);
      const target = views.target(edge) ?? undefined;
      out.push({
        file: node.file,
        index,
        usage,
        edge,
        ...(target && { target }),
        via,
        certainty: combined,
      });
      const child = target && views.graph.components.get(target);
      if (child && child.file !== file && !via.some((step) => step.from === child.file))
        expand(child, [...via, edge], combined);
    }
  };
  const node = views.graph.components.get(file);
  if (node) expand(node, [], certainty);
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
): Placement {
  if (item.conditional || item.inFor) return undefined;
  if (item.builtInHosts.some((tag) => DETACHED.has(tag.replaceAll("-", "").toLowerCase())))
    return undefined;
  if (!item.host) return "proven";
  const { slot } = item.host;
  const host = node.facts.usages[item.host.usage];
  const edge = node.renders[item.host.usage];
  if (!host || !edge || slot === null) return undefined;
  const tag = pascalTag(host.tag);
  if (OVERLAY.test(tag)) return undefined;
  const outer = placement(views, node, host, layout, visiting);
  if (!outer) return undefined;
  if (tag === "NuxtLayout") {
    if (slot !== "default") return undefined;
    return layout ? weaker(outer, slotPlacement(views, layout, slot, layout, visiting)) : outer;
  }
  const target = views.target(edge);
  if (target === null) return undefined;
  if (target) return weaker(outer, slotPlacement(views, target, slot, layout, visiting));
  return slot === "default" ? weaker(outer, "heuristic") : undefined;
}

function slotPlacement(
  views: ViewGraph,
  file: string,
  slot: string,
  layout: string | undefined,
  visiting: Set<string>,
): Placement {
  const key = `${file}#${slot}`;
  const node = views.graph.components.get(file);
  if (!node || visiting.has(key)) return undefined;
  const next = new Set(visiting).add(key);
  return strongest(
    node.facts.slotOutlets
      .filter((outlet) => outlet.name === slot)
      .map((outlet) => placement(views, node, outlet, layout, next)),
  );
}

function weaker(left: Certainty, right: Certainty): Certainty;
function weaker(left: Certainty, right: Placement): Placement;
function weaker(left: Certainty, right: Placement): Placement {
  if (!right) return undefined;
  return left === "heuristic" || right === "heuristic" ? "heuristic" : "proven";
}

function strongest(placements: Placement[]): Placement {
  if (placements.includes("proven")) return "proven";
  return placements.includes("heuristic") ? "heuristic" : undefined;
}
