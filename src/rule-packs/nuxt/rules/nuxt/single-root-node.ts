import type {
  ComponentUsageFact,
  ComponentUsageGraph,
  RuleContext,
} from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { createRule } from "./shared.js";
import {
  displayPath,
  isInsideDir,
  isManifestRoute,
  isScannedNuxtFile,
  nuxtLayerSources,
  pageMetaFlag,
  pascalTag,
  readAppConfigFlag,
  readSfc,
  routesAreKnown,
  templateRootShape,
  type ConfigFlag,
  type MetaFlag,
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
        const outlet = nuxtPageTransition(graph);
        for (const layers of nuxtLayerSources(ctx)) {
          const pageConfig = readAppConfigFlag(ctx, layers, "pageTransition");
          const layoutConfig = readAppConfigFlag(ctx, layers, "layoutTransition");
          for (const layer of layers) {
            const pagesDir = `${layer.srcDir}/pages`;
            const routesKnown = routesAreKnown(ctx, layer.root);
            for (const file of sources) {
              if (!file.endsWith(".vue") || !isScannedNuxtFile(file)) continue;
              if (isInsideDir(file, pagesDir) && routesKnown && isManifestRoute(ctx, file)) {
                await checkPage(ctx, file, outlet, pageConfig);
              } else if (isInsideDir(file, `${layer.srcDir}/layouts`)) {
                if (layoutConfig?.state !== "on") continue;
                const source = `app.layoutTransition in ${displayPath(ctx, layoutConfig.file)}`;
                await checkFile(ctx, file, "layout", source);
              }
            }
          }
        }
      },
    };
  },
});

async function checkPage(
  ctx: RuleContext,
  file: string,
  outlet: OutletTransition,
  config: ConfigFlag | undefined,
) {
  if (outlet === "unknown") return;
  if (outlet === "on") return checkFile(ctx, file, "page", "the transition prop on <NuxtPage>");
  const sfc = await readSfc(ctx, file);
  const meta: MetaFlag = sfc?.script ? pageMetaFlag(sfc.script, "pageTransition") : undefined;
  if (meta === "on") return checkFile(ctx, file, "page", "definePageMeta({ pageTransition })");
  if (meta === undefined && config?.state === "on")
    return checkFile(ctx, file, "page", `app.pageTransition in ${displayPath(ctx, config.file)}`);
}

async function checkFile(ctx: RuleContext, file: string, kind: "page" | "layout", source: string) {
  const sfc = await readSfc(ctx, file);
  if (!sfc?.template) return;
  const shape = templateRootShape(sfc.template);
  if (shape.kind === "single" || shape.kind === "unknown") return;
  report(ctx, file, sfc.text, kind, shape, source);
}

type OutletTransition = "unset" | "on" | "unknown";

/**
 * NuxtPage's `transition` prop overrides page meta and app config. When every <NuxtPage> sets
 * it to a truthy literal, every page transitions; when any sets something else, Doctor cannot
 * tell which pages it renders.
 */
function nuxtPageTransition(graph: ComponentUsageGraph): OutletTransition {
  const values = [...graph.components.values()].flatMap((node) =>
    node.facts.usages.filter((usage) => pascalTag(usage.tag) === "NuxtPage").map(transitionProp),
  );
  // An explicit `false` turns off transitions for the pages that <NuxtPage> renders.
  if (values.some((value) => value === "off" || value === "unknown")) return "unknown";
  if (values.length && values.every((value) => value === "on")) return "on";
  return "unset";
}

function transitionProp(usage: ComponentUsageFact): OutletTransition | "off" {
  if (usage.spreads.some((spread) => spread.directive === "bind")) return "unknown";
  const attribute = usage.attributes.find((attr) => attr.name === "transition");
  // A Boolean prop written as a bare attribute is true.
  if (attribute) return attribute.value === undefined || attribute.value === "" ? "on" : "unknown";
  const binding = usage.bindings.find((bind) => bind.name === "transition");
  if (!binding) return "unset";
  const expression = binding.expression.trim();
  if (expression === "true" || expression.startsWith("{")) return "on";
  if (expression === "false") return "off";
  return "unknown";
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
