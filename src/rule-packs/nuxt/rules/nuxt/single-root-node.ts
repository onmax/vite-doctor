import type { ComponentUsageFact, RuleContext } from "../../../../core/index.js";
import { parseScript } from "../../../../core/internal/script.js";
import { diagnostics } from "../../diagnostics.js";
import { unwrap } from "./nuxt-config-ast.js";
import { createRule, type AnyNode } from "./shared.js";
import {
  displayPath,
  LAYOUT_OUTLETS,
  LAYOUT_OUTLET_MENTION,
  mainApp,
  nuxtLayerSources,
  PAGE_OUTLETS,
  PAGE_OUTLET_MENTION,
  pageMetaFlag,
  pageMetaValue,
  pageRoutes,
  pascalTag,
  reachableOutlets,
  readAppConfigFlag,
  readSfc,
  registeredLayouts,
  templateRootShape,
  transitionFlag,
  type ConfigFlag,
  type MetaFlag,
  type PageRoute,
  type RootShape,
} from "./page-structure.js";

const RULE_ID = "nuxt/pages/single-root-node";

export const singleRootNode = createRule({
  meta: {
    id: RULE_ID,
    title: "Give transitioned pages and layouts a single root node",
    category: "correctness",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/getting-started/transitions",
    execution: "workspace",
    cacheScope: "none",
    requires: { nuxt: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph"],
    cost: "small",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const sources = await ctx.inventory.sourcePaths();
        const graph = await ctx.inventory.componentUsage();
        for (const layers of nuxtLayerSources(ctx)) {
          const routes = pageRoutes(ctx, layers, sources);
          const app = mainApp(ctx, layers);
          if (!routes || app === null) continue;
          const pageConfig = readAppConfigFlag(ctx, layers, "pageTransition");
          const layoutConfig = readAppConfigFlag(ctx, layers, "layoutTransition");
          const layouts = registeredLayouts(ctx, layers, sources) ?? [];
          const sourcesByFile = new Map<string, ReturnType<typeof readSfc>>();
          const readPage = (file: string) => {
            let sfc = sourcesByFile.get(file);
            if (!sfc) sourcesByFile.set(file, (sfc = readSfc(ctx, file)));
            return sfc;
          };
          const pending = new Map<string, { kind: "page" | "layout"; source: string }>();
          const pageOutlets = new Map<string, ComponentUsageFact | null>();
          const getPageOutlet = (file: string) => {
            if (!pageOutlets.has(file)) {
              pageOutlets.set(
                file,
                routeOutlet(reachableOutlets(ctx, graph, file, PAGE_OUTLETS, PAGE_OUTLET_MENTION)),
              );
            }
            return pageOutlets.get(file);
          };
          const layoutOutlets = new Map<string, ComponentUsageFact[]>();
          const getLayoutOutlets = (file: string | undefined) => {
            if (!file) return [undefined];
            let usages = layoutOutlets.get(file);
            if (!usages) {
              usages = reachableOutlets(
                ctx,
                graph,
                file,
                LAYOUT_OUTLETS,
                LAYOUT_OUTLET_MENTION,
              ).usages;
              layoutOutlets.set(file, usages);
            }
            return usages;
          };
          const byFile = new Map<string, PageRoute | null>();
          for (const route of routes) byFile.set(route.file, byFile.has(route.file) ? null : route);
          const defaultParents = new Set(
            routes.filter((route) => route.path === "").map((route) => route.parent),
          );
          for (const route of routes) {
            if (defaultParents.has(route.file)) continue;
            const chain = routeChain(route, byFile);
            if (!chain) continue;
            let pageMeta: MetaFlag;
            let layoutMeta: MetaFlag;
            let layoutName: LayoutName;
            for (const { file } of chain) {
              const sfc = file.endsWith(".vue") ? await readPage(file) : undefined;
              if (!sfc?.template) {
                pageMeta = layoutMeta = layoutName = "unknown";
                continue;
              }
              pageMeta = pageMetaFlag(sfc.script, "pageTransition") ?? pageMeta;
              layoutMeta = pageMetaFlag(sfc.script, "layoutTransition") ?? layoutMeta;
              layoutName = pageMetaValue(sfc.script, "layout", staticLayoutName) ?? layoutName;
            }
            const layoutSource = enabledTransition(
              ctx,
              layoutMeta,
              layoutConfig,
              "layoutTransition",
            );
            if (layoutSource) {
              for (const outlet of getLayoutOutlets(app))
                addLayout(outlet, layoutName, layoutSource);
            }
            for (const { file, parent } of chain) {
              const owner = parent ?? app;
              const outlet = owner ? getPageOutlet(owner) : undefined;
              if (outlet === null) break;
              const flag = outlet ? outletTransition(outlet) : "unset";
              const source =
                flag === "on"
                  ? "the transition prop on <NuxtPage>"
                  : flag === "unset"
                    ? enabledTransition(ctx, pageMeta, pageConfig, "pageTransition")
                    : undefined;
              if (source) pending.set(file, { kind: "page", source });
              if (layoutSource) {
                for (const layout of getLayoutOutlets(file))
                  addLayout(layout, layoutName, layoutSource);
              }
            }
          }
          if (!routes.length && layoutConfig?.state === "on") {
            const source = enabledTransition(ctx, undefined, layoutConfig, "layoutTransition")!;
            for (const outlet of getLayoutOutlets(app)) addLayout(outlet, undefined, source);
          }
          for (const [file, { kind, source }] of pending)
            if (file.endsWith(".vue")) await checkFile(ctx, file, kind, source);

          function addLayout(
            outlet: ComponentUsageFact | undefined,
            layoutName: LayoutName,
            source: string,
          ) {
            const name = outlet ? (layoutProp(outlet) ?? layoutName) : layoutName;
            if (name === false || name === "unknown") return;
            const layout = layouts.find((candidate) => candidate.name === (name ?? "default"));
            if (layout) pending.set(layout.file, { kind: "layout", source });
          }
        }
      },
    };
  },
});

function enabledTransition(
  ctx: RuleContext,
  meta: MetaFlag,
  config: ConfigFlag | undefined,
  key: "pageTransition" | "layoutTransition",
) {
  if (meta === "on") return `definePageMeta({ ${key} })`;
  if (meta === undefined && config?.state === "on")
    return `app.${key} in ${displayPath(ctx, config.file)}`;
}

async function checkFile(ctx: RuleContext, file: string, kind: "page" | "layout", source: string) {
  const sfc = await readSfc(ctx, file);
  if (!sfc?.template) return;
  const shape = templateRootShape(sfc.template);
  if (shape.kind === "single" || shape.kind === "unknown") return;
  report(ctx, file, sfc.text, kind, shape, source);
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

function routeOutlet({ usages, unknown }: ReturnType<typeof reachableOutlets>) {
  if (unknown || usages.length !== 1) return null;
  const usage = usages[0]!;
  if (
    pascalTag(usage.tag) !== "NuxtPage" ||
    usage.spreads.some((spread) => spread.directive === "bind") ||
    usage.bindings.some((binding) => ["name", "route"].includes(binding.name)) ||
    usage.attributes.some((attribute) => attribute.name === "name" && attribute.value !== "default")
  )
    return null;
  return usage;
}

function outletTransition(usage: ComponentUsageFact) {
  const attribute = usage.attributes.find((attr) => attr.name === "transition");
  // A Boolean prop written as a bare attribute is true.
  if (attribute) return attribute.value === undefined || attribute.value === "" ? "on" : "unknown";
  const binding = usage.bindings.find((bind) => bind.name === "transition");
  if (!binding) return "unset";
  return transitionFlag(parseExpression(binding.expression)) ?? "unset";
}

type LayoutName = string | false | undefined;

function staticLayoutName(value: AnyNode): LayoutName {
  if (value?.type !== "Literal") return "unknown";
  if (value.value === null) return undefined;
  return typeof value.value === "string" || value.value === false ? value.value : "unknown";
}

function layoutProp(usage: ComponentUsageFact): LayoutName {
  if (
    usage.spreads.some((spread) => spread.directive === "bind") ||
    usage.attributes.some((attr) => attr.name === "fallback") ||
    usage.bindings.some((bind) => bind.name === "fallback")
  )
    return "unknown";
  const binding = usage.bindings.find((bind) => bind.name === "name");
  if (binding) return staticLayoutName(parseExpression(binding.expression));
  return usage.attributes.find((attr) => attr.name === "name")?.value;
}

function parseExpression(text: string): AnyNode {
  const program = parseScript("expression.ts", `(${text})`) as AnyNode;
  const statement = program?.body?.[0];
  return program?.body?.length === 1 && statement?.type === "ExpressionStatement"
    ? unwrap(statement.expression)
    : undefined;
}

function report(
  ctx: RuleContext,
  file: string,
  text: string,
  kind: "page" | "layout",
  shape: Exclude<RootShape, { kind: "single" } | { kind: "unknown" }>,
  source: string,
) {
  const name = displayPath(ctx, file);
  const runtimeCode = kind === "page" ? "NUXT_E4004" : "NUXT_E4002";
  const transitionName = kind === "page" ? "page transition" : "layout transition";
  const root =
    shape.kind === "multiple"
      ? `${shape.count} root nodes`
      : shape.kind === "comment"
        ? "a comment at its root, which Vue keeps in development and turns into a second root node"
        : "text at its root";
  ctx.report(
    diagnostics.NUXT0100({
      why: `${name} has ${root}. ${source} wraps this ${kind} in a ${transitionName}, and a <Transition> can only animate a single root element, so navigating to or from this ${kind} does not animate. Nuxt warns about this at runtime as ${runtimeCode}.`,
      fix:
        shape.kind === "comment"
          ? `Move the comment inside the root element of ${name}.`
          : `Wrap the template of ${name} in a single root element, such as a <div>.`,
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "correctness",
      file,
      range: ctx.helpers.rangeFromOffsets(file, text, shape.node.start, shape.node.end),
      confidence: "heuristic-high",
      evidence: [
        { kind: "facts", file, summary: `The template of ${name} has ${root.split(",")[0]}.` },
      ],
    },
  );
}
