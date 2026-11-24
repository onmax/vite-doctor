import type { RuleContext } from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { createRule } from "./shared.js";
import {
  findOutlet,
  isInsideDir,
  isManifestRoute,
  isScannedNuxtFile,
  nuxtLayerSources,
  routesAreKnown,
  templateTagRange,
} from "./page-structure.js";

const RULE_ID = "nuxt/routing/parent-page-requires-nuxtpage";
const PAGE_OUTLETS = new Set(["NuxtPage", "RouterView"]);
const PAGE_OUTLET_MENTION = /\b(?:NuxtPage|RouterView|nuxt-page|router-view)\b/;

export const parentPageRequiresNuxtPage = createRule({
  meta: {
    id: RULE_ID,
    title: "Render NuxtPage in parent pages",
    category: "routing",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/directory-structure/app/pages#nested-routes",
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
        let graph: Awaited<ReturnType<typeof ctx.inventory.componentUsage>> | undefined;
        for (const layers of nuxtLayerSources(ctx)) {
          for (const layer of layers) {
            const pagesDir = `${layer.srcDir}/pages`;
            const pages = sources.filter(
              (file) => isInsideDir(file, pagesDir) && isScannedNuxtFile(file),
            );
            if (!pages.length || !routesAreKnown(ctx, layer.root)) continue;
            for (const parent of pages) {
              if (!parent.endsWith(".vue")) continue;
              const childDir = parent.slice(0, -".vue".length);
              const children = pages.filter((file) => isInsideDir(file, childDir));
              if (
                !children.length ||
                !isManifestRoute(ctx, parent) ||
                !children.some((file) => isManifestRoute(ctx, file))
              )
                continue;
              graph ??= await ctx.inventory.componentUsage();
              const search = findOutlet(ctx, graph, parent, PAGE_OUTLETS, PAGE_OUTLET_MENTION);
              if (search.state !== "absent") continue;
              report(ctx, parent, children, pagesDir);
            }
          }
        }
      },
    };
  },
});

function report(ctx: RuleContext, parent: string, children: string[], pagesDir: string) {
  const text = ctx.fs.readText(parent) ?? "";
  const route = (file: string) => file.slice(pagesDir.length + 1);
  const parentRoute = route(parent);
  const childList = children
    .slice(0, 3)
    .map((file) => `pages/${route(file)}`)
    .join(", ");
  const more = children.length > 3 ? ` and ${children.length - 3} more` : "";
  ctx.report(
    diagnostics.NUXT0098({
      why: `pages/${parentRoute} sits next to the pages/${parentRoute.slice(0, -".vue".length)}/ directory, so Nuxt makes it the parent route of ${childList}${more}. A child page renders inside its parent's <NuxtPage>, and neither this page nor any component Doctor resolved from its template renders one, so navigating to a child route shows only the parent. Nuxt warns about this at runtime as NUXT_E4016.`,
      fix: `Render <NuxtPage /> in pages/${parentRoute} where the child page should appear. If the files are separate pages rather than nested ones, move pages/${parentRoute} to pages/${parentRoute.slice(0, -".vue".length)}/index.vue.`,
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "routing",
      file: parent,
      range: templateTagRange(ctx, parent, text),
      confidence: "heuristic-high",
      evidence: [
        {
          kind: "graph",
          file: parent,
          summary: `No component reachable from pages/${parentRoute} renders <NuxtPage> or <RouterView>.`,
        },
      ],
      related: children.slice(0, 5).map((file) => ({
        file,
        message: `Child route of pages/${parentRoute}`,
      })),
    },
  );
}
