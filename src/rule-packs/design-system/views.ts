import { basename, join, relative } from "pathe";
import type {
  ComponentNode,
  ComponentSlotOutletFact,
  ComponentUsageEdge,
  ComponentUsageFact,
  ComponentUsageGraph,
  RuleContext,
  SourceRange,
  TemplateAstNode,
  TemplateExpressionNode,
} from "../../core/index.js";
import { bindingMaySet, camelize } from "../../core/internal/component-facts.js";
import {
  analyzeScriptProgram,
  parseScriptScope,
  type ScopeManager,
  type ScopeVariable,
} from "../../core/internal/script-scope.js";
import { parseScript, parseScriptResult } from "../../core/internal/script.js";
import { TemplateNodeType, templateDirectiveBindings } from "../../core/internal/template.js";
import { walkScriptLocal } from "../../core/rule-authoring.js";
import type { NuxtAppSource } from "../nuxt/rules/nuxt/file-classification.js";
import { propertyName, unwrap } from "../nuxt/rules/nuxt/nuxt-config-ast.js";
import {
  displayPath,
  mainApp,
  nuxtLayerSources,
  type PageRoute,
  pageMetaValue,
  pageRoutes,
  pascalTag,
  readSfc,
  registeredLayouts,
  unreadLayers,
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

/** Why some routes have no View, or a partial one, once per cause. */
export interface ViewGap {
  message: string;
  /** The files that cause it, relative to the project root. */
  files: string[];
}

const PREPARE =
  "Run nuxt prepare with vite-doctor/nuxt to write .nuxt/doctor.manifest.json, then rerun Doctor.";
const LITERAL_LAYOUT =
  "Move layout selection to a literal definePageMeta({ layout }) on each affected page.";
const REMOVE_APP_LAYOUT = `Remove appLayout from the route rules (or remove the call if it only sets the layout). ${LITERAL_LAYOUT}`;

/**
 * Every View of the Doctor Run's Nuxt apps that Doctor can establish. A route whose view depends
 * on something Doctor cannot read statically, such as a computed layout, has no View, and `gaps`
 * names why. Projects without Nuxt have no Views: Doctor cannot tell which components render
 * together without routes.
 */
export async function projectViews(
  ctx: RuleContext,
  resolved: ViewGraph,
): Promise<{ views: View[]; gaps: ViewGap[] }> {
  const { graph } = resolved;
  type Message = (files: string, count: number) => string;
  const causes = new Map<string, { files: Set<string>; message: Message }>();
  const gap = (cause: string, files: string[], message: Message) => {
    const entry = causes.get(cause) ?? { files: new Set<string>(), message };
    entry.message = message;
    for (const file of files) entry.files.add(displayPath(ctx, file));
    causes.set(cause, entry);
  };
  const views: View[] = [];
  if (!ctx.project.nuxt) return { views, gaps: [] };
  const sources = await ctx.inventory.sourcePaths();
  for (const [index, layers] of nuxtLayerSources(ctx).entries()) {
    const appRoot = layers[0]!.root;
    const at = appRoot === ctx.project.root ? "" : ` at ${displayPath(ctx, appRoot)}`;
    const everyRoute = `DS0008 did not count component limits on any route of the Nuxt app${at}`;
    const config = configPath(ctx, appRoot);
    const routes = pageRoutes(ctx, layers, sources);
    if (!routes) {
      const reason =
        unreadLayers(ctx, layers)?.replace(/\.$/, "") ??
        (layers.length === 1
          ? `${displayPath(ctx, config)} or .nuxtignore changes which files Nuxt scans as pages`
          : `no current Doctor manifest lists the pages of its ${layers.length} layers`);
      gap(
        `routes${appRoot}`,
        [config],
        () =>
          `Doctor cannot list the routes of the Nuxt app${at}: ${reason}. ${everyRoute}. ${PREPARE}`,
      );
      continue;
    }
    if (!routes.length) continue;
    const app = mainApp(ctx, layers);
    if (app === null) {
      gap(
        `app${appRoot}`,
        [config],
        () =>
          `Doctor cannot tell which app component the Nuxt app${at} renders: an app:resolve or app:templates hook, several app files, or a layer it cannot read picks it. ${everyRoute}. ${PREPARE}`,
      );
      continue;
    }
    if (app && !graph.components.has(app)) {
      gap("unread", [app], unreadMessage);
      continue;
    }
    const main = index === 0 && !!ctx.project.nuxt.layers?.length;
    const runtime = await runtimeLayouts(ctx, layers, main, sources, routes);
    if ("everywhere" in runtime) {
      const { everywhere, file } = runtime;
      gap(`${everywhere}${appRoot}`, [file], (files) =>
        everywhere === "api"
          ? `${files} references setPageLayout(), which can switch any route's layout at runtime, so ${everyRoute}. Remove the setPageLayout reference. ${LITERAL_LAYOUT}`
          : everywhere === "rules"
            ? `${files} calls defineRouteRules() outside a page, where it may set appLayout for any route, so ${everyRoute}. ${REMOVE_APP_LAYOUT}`
            : `${files} sets appLayout in routeRules, and without a current Doctor manifest Doctor cannot tell which routes it matches, so ${everyRoute}. ${PREPARE}`,
      );
      continue;
    }
    const layouts = registeredLayouts(ctx, layers, sources);
    const byFile = new Map<string, PageRoute | null>();
    for (const route of routes) byFile.set(route.file, byFile.has(route.file) ? null : route);
    const defaultParents = new Set(
      routes.filter((route) => route.path === "").map((route) => route.parent),
    );
    const patterns = new Set<string>();
    for (const route of routes) {
      if (defaultParents.has(route.file)) continue;
      const chain = routeChain(route, byFile);
      if (!chain) {
        gap(
          "parent",
          [route.file],
          (files) =>
            `Doctor cannot tell which parent route renders ${files}, so DS0008 did not count component limits on their routes. ${PREPARE}`,
        );
        continue;
      }
      const unread = chain.filter(({ file }) => !graph.components.has(file));
      if (unread.length) {
        gap(
          "unread",
          unread.map(({ file }) => file),
          unreadMessage,
        );
        continue;
      }
      const rules = chain.filter(({ file }) => runtime.pages.has(file));
      if (rules.length) {
        gap(
          "page-rules",
          rules.map(({ file }) => file),
          (files) =>
            `${files} call defineRouteRules(), which may set appLayout, so DS0008 did not count component limits on their routes. ${REMOVE_APP_LAYOUT}`,
        );
        continue;
      }
      let layout: LayoutChoice | "unknown" | undefined;
      let path: string | undefined = "";
      const computed: string[] = [];
      for (const { file, parent, path: preparedPath } of chain) {
        const sfc = await readSfc(ctx, file);
        if (!sfc) {
          layout = "unknown";
          path = undefined;
          computed.push(file);
        } else {
          const own = pageMetaValue(sfc.script, "layout", staticLayout);
          if (own === "unknown") computed.push(file);
          layout = own ?? layout;
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
      if (layout === "unknown") {
        gap(
          "layout",
          computed,
          (files) =>
            `${files} set a layout Doctor cannot read statically in definePageMeta({ layout }), so DS0008 did not count component limits on their routes. Pass a string literal or false instead.`,
        );
        continue;
      }
      const label = route.fullPath ?? path ?? relative(ctx.project.root, route.file);
      const matched = runtime.patterns.filter((pattern) => mayMatch(pattern, label));
      if (matched.length) {
        for (const pattern of matched) patterns.add(pattern);
        gap(`patterns${appRoot}`, [route.file], (files, count) => {
          return `appLayout route rules ${[...patterns].join(", ")} may pick the layout of ${count} route${count === 1 ? "" : "s"}, which DS0008 does not follow, so it did not count component limits on ${files}. Remove appLayout from the matching route rules. ${LITERAL_LAYOUT} ${PREPARE}`;
        });
        continue;
      }
      const name = layout?.name ?? "default";
      const layoutFile =
        name === false ? undefined : layouts?.find((entry) => entry.name === name)?.file;
      if (layoutFile === undefined && name !== false && !layouts) {
        gap(
          `layouts${appRoot}`,
          [config],
          () =>
            `Doctor cannot list the layouts of the Nuxt app${at}, so ${everyRoute} that uses one. ${PREPARE}`,
        );
        continue;
      }
      if (layoutFile && !graph.components.has(layoutFile)) {
        gap("unread", [layoutFile], unreadMessage);
        continue;
      }
      const placed = viewRoots(resolved, app, layoutFile, chain);
      if (!placed) {
        gap(
          "layout-name",
          [app!],
          (files) =>
            `${files} passes name or fallback to <NuxtLayout>, which can override every page's layout, so ${everyRoute}. Pick layouts with definePageMeta({ layout }) and render <NuxtLayout> without name or fallback.`,
        );
        continue;
      }
      if (placed.unplacedFrom)
        gap(
          "outlet",
          placed.unplacedFrom,
          (files) =>
            `Doctor cannot verify that ${files} renders the route's page: the <NuxtPage> or <RouterView> is missing, conditional, named, given a route or slot content, or sits in a slot Doctor cannot follow. DS0008 counted those routes without their pages. Render an unconditional <NuxtPage /> and, if it passes through a layout, give the layout an unconditional default <slot />.`,
        );
      views.push({ route: label, page: route.file, layout: layoutFile, roots: placed.roots });
    }
  }
  const gaps = [...causes.values()].map(({ files, message }) => {
    const sorted = [...files].sort();
    return { message: message(sorted.join(", "), sorted.length), files: sorted };
  });
  return { views, gaps };
}

function unreadMessage(files: string): string {
  return `Doctor has no component facts for ${files}, so DS0008 did not count component limits on the routes that render them. Make each one a .vue SFC Doctor can parse.`;
}

function configPath(ctx: RuleContext, root: string): string {
  return (
    NUXT_CONFIGS.map((name) => join(root, name)).find((file) => ctx.fs.exists(file)) ??
    join(root, "nuxt.config.ts")
  );
}

/** Where the app may pick a layout at runtime, outside `definePageMeta`. */
interface RuntimeLayouts {
  /** Pages whose own `defineRouteRules` may set `appLayout`. */
  pages: Set<string>;
  /** Route rule patterns that set `appLayout`. */
  patterns: string[];
}

const SET_PAGE_LAYOUT = /\bsetPageLayout\b/;
const LAYOUT_API = "setPageLayout";
const LAYOUT_IMPORTS = ["#imports", "#app", "nuxt", "nuxt/app", "#app/composables/router"];
const DEFINE_ROUTE_RULES = /\bdefineRouteRules\b/;
const NUXT_CONFIGS = ["ts", "mts", "js", "mjs", "cjs", "cts"].map((ext) => `nuxt.config.${ext}`);

/**
 * `setPageLayout()` can switch any route's layout, so a reference in the app's sources, or in a file no
 * app owns, leaves the app without Views. An `appLayout` route rule removes the routes it may match
 * when Nuxt's manifest records the rules, and the whole app when only the config text shows it.
 */
async function runtimeLayouts(
  ctx: RuleContext,
  layers: NuxtAppSource[],
  main: boolean,
  sources: readonly string[],
  routes: PageRoute[],
): Promise<RuntimeLayouts | { everywhere: "api" | "rules" | "config"; file: string }> {
  const owners = nuxtLayerSources(ctx).flat();
  const owns = (file: string) => layers.some(({ root }) => file.startsWith(`${root}/`));
  const pages = new Set(routes.map(({ file }) => file));
  const found: RuntimeLayouts = { pages: new Set(), patterns: [] };
  for (const file of sources) {
    if (!owns(file) && owners.some(({ root }) => file.startsWith(`${root}/`))) continue;
    if (/\.d\.[cm]?ts$/.test(file)) continue;
    const text = ctx.fs.readText(file);
    if (!text) continue;
    const mayUseLayoutApi =
      SET_PAGE_LAYOUT.test(text) || LAYOUT_IMPORTS.some((source) => text.includes(source));
    if (!mayUseLayoutApi && !DEFINE_ROUTE_RULES.test(text)) continue;
    const sfc = file.endsWith(".vue") ? await readSfc(ctx, file) : undefined;
    const script = file.endsWith(".vue")
      ? sfc?.script
      : parseScriptResult(file, text, undefined, { astType: "ts", range: true }).ast;
    if (mayUseLayoutApi && usesLayoutApi(script, sfc?.template)) return { everywhere: "api", file };
    if (
      NUXT_CONFIGS.includes(basename(file)) ||
      !callsApi(script, "defineRouteRules", maySetRouteLayout)
    )
      continue;
    if (!owns(file) || !pages.has(file)) return { everywhere: "rules", file };
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
        if (hasProperty(ast, "routeRules") && hasProperty(ast, "appLayout"))
          return { everywhere: "config", file };
      }
  if (recorded)
    for (const rules of [ctx.project.nuxt?.routeRules, manifest.resolvedRouteRules])
      for (const [pattern, rule] of Object.entries(rules ?? {}))
        if (rule && typeof rule === "object" && "appLayout" in rule) found.patterns.push(pattern);
  return found;
}

function layoutImport(binding: ScopeVariable | null | undefined, namespace: boolean): boolean {
  return !!binding?.defs.some(({ type, node, parent }) => {
    if (
      type !== "ImportBinding" ||
      parent.type !== "ImportDeclaration" ||
      parent.importKind === "type" ||
      !LAYOUT_IMPORTS.includes(parent.source.value)
    )
      return false;
    if (namespace) return node.type === "ImportNamespaceSpecifier";
    return (
      node.type === "ImportSpecifier" &&
      node.importKind !== "type" &&
      (node.imported.type === "Identifier" ? node.imported.name : node.imported.value) ===
        LAYOUT_API
    );
  });
}

function usesLayoutApi(script: any, template: TemplateAstNode | null | undefined): boolean {
  let scope: ScopeManager | undefined;
  try {
    if (script) scope = analyzeScriptProgram(script, "module");
  } catch {
    return true;
  }
  if (scope && referencesLayoutApi(script, scope)) return true;
  if (!template) return false;
  const bindings = scope?.scopes.find(({ type }) => type === "module")?.set;
  const names = [
    LAYOUT_API,
    ...[...(bindings ?? [])].flatMap(([name, binding]) =>
      layoutImport(binding, false) || layoutImport(binding, true) ? [name] : [],
    ),
  ];
  return visit(template, []);

  function scan(source: string, locals: string[]) {
    if (!names.some((name) => source.includes(name))) return false;
    try {
      const { ast, scopeManager } = parseScriptScope(source, { sourceType: "module" });
      return referencesLayoutApi(ast, scopeManager, bindings, locals);
    } catch {
      return false;
    }
  }

  function reads(expression: TemplateExpressionNode | undefined, locals: string[], event = false) {
    if (expression?.isStatic || !expression?.content) return false;
    const source = expression.content;
    return scan(event ? `($event) => {\n${source}\n}` : `(\n${source}\n)`, locals);
  }

  function readsParams(params: Array<TemplateExpressionNode | undefined>, locals: string[]) {
    const source = params.flatMap((param) => (param?.content ? [param.content] : [])).join(", ");
    return scan(`(${source}) => {}`, locals);
  }

  function visit(node: TemplateAstNode, locals: string[]): boolean {
    if (node.type === TemplateNodeType.INTERPOLATION) return reads(node.content, locals);
    if (node.type === TemplateNodeType.ROOT)
      return node.children.some((child) => visit(child, locals));
    if (node.type !== TemplateNodeType.ELEMENT) return false;
    const directives = node.props.filter((prop) => prop.type === TemplateNodeType.DIRECTIVE);
    const loop = directives.find(({ name }) => name === "for");
    const slot = directives.find(({ name }) => name === "slot");
    if (reads(loop?.forParseResult?.source, locals)) return true;
    const loopParams = loop?.forParseResult;
    if (loopParams && readsParams([loopParams.value, loopParams.key, loopParams.index], locals))
      return true;
    const inLoop = loop ? [...locals, ...templateDirectiveBindings(loop)] : locals;
    if (
      directives.some(
        ({ arg, exp, name }) =>
          reads(arg, inLoop) ||
          (name !== "for" &&
            name !== "slot" &&
            reads(
              exp,
              name === "if" || name === "else-if" ? locals : inLoop,
              name === "on" && !!arg,
            )),
      )
    )
      return true;
    if (slot && readsParams([slot.exp], inLoop)) return true;
    const inSlot = slot ? [...inLoop, ...templateDirectiveBindings(slot)] : inLoop;
    return node.children.some((child) => visit(child, inSlot));
  }
}

function referencesLayoutApi(
  ast: unknown,
  scope: ScopeManager,
  outer?: ReadonlyMap<string, ScopeVariable>,
  locals: string[] = [],
): boolean {
  const namespaces = new Set<unknown>();
  for (const { references } of scope.scopes)
    for (const ref of references) {
      if (!ref.isValueReference || !ref.isRead()) continue;
      const { identifier, resolved } = ref;
      if (!resolved && locals.includes(identifier.name)) continue;
      const binding = resolved ?? outer?.get(identifier.name);
      if (binding?.isValueVariable) {
        if (layoutImport(binding, false)) return true;
        if (layoutImport(binding, true)) namespaces.add(identifier);
      } else if (identifier.name === LAYOUT_API) return true;
    }
  if (!namespaces.size) return false;
  walkScriptLocal(ast, (node) => {
    if (node.type === "MemberExpression") {
      const member = propertyName({ key: node.property, computed: node.computed });
      if (member !== null && member !== LAYOUT_API) namespaces.delete(unwrap(node.object));
    } else if (node.type === "VariableDeclarator") {
      clearDestructure(node.id, node.init);
    } else if (node.type === "ExpressionStatement") {
      const expression = unwrap(node.expression);
      if (expression?.type === "AssignmentExpression" && expression.operator === "=")
        clearDestructure(expression.left, expression.right);
    }
  });
  return namespaces.size > 0;

  function clearDestructure(pattern: unknown, source: unknown) {
    const read = unwrap(source);
    if (!namespaces.has(read)) return;
    const target = unwrap(pattern);
    if (
      target?.type === "ObjectPattern" &&
      target.properties.every((property: { type: string }) => {
        if (property.type !== "Property") return false;
        const member = propertyName(property);
        return member !== null && member !== LAYOUT_API;
      })
    )
      namespaces.delete(read);
  }
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
 * app picks its layout in a way Doctor cannot read. `unplacedFrom` names the files to check when
 * Doctor cannot follow a router outlet and the View stops before the route's page.
 */
function viewRoots(
  graph: ViewGraph,
  app: string | undefined,
  layout: string | undefined,
  chain: PageRoute[],
): { roots: ViewRoot[]; unplacedFrom?: string[] } | undefined {
  const roots: ViewRoot[] = [];
  let from = app ? [app] : layout ? [layout] : [];
  let pages = layout ? slotPlacement(graph, layout, "default", layout, new Set()) : [DIRECT];
  if (app) {
    roots.push({ file: app, kind: "app", ...DIRECT });
    const rendered = renderedUsages(graph, app, layout);
    const layouts = rendered.filter(({ edge }) => graph.outlet(edge) === "NuxtLayout");
    if (layouts.some(({ usage }) => choosesLayout(usage))) return undefined;
    if (layout) {
      if (layouts.length && !pages.length) from.push(layout);
      for (const mount of layouts)
        roots.push({ file: layout, kind: "layout", ...throughUsage(mount) });
    }
    pages = pageOutlets(graph, rendered);
  } else if (layout) {
    roots.push({ file: layout, kind: "layout", ...DIRECT });
  }
  for (const [index, route] of chain.entries()) {
    if (!pages.length) return { roots, unplacedFrom: from };
    for (const path of pages) roots.push({ file: route.file, kind: "page", ...path });
    if (index === chain.length - 1) break;
    const outlets = pageOutlets(graph, renderedUsages(graph, route.file, layout));
    pages = pages.flatMap((parent) => outlets.map((outlet) => joinPaths(parent, outlet)));
    from = [route.file];
  }
  return { roots };
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
