import type { RuleContext } from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { createRule } from "./shared.js";
import {
  findOutlet,
  displayPath,
  PAGE_OUTLETS,
  PAGE_OUTLET_MENTION,
  nuxtLayerSources,
  pageRoutes,
  templateTagRange,
} from "./page-structure.js";

const RULE_ID = "nuxt/routing/parent-page-requires-nuxtpage";

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
          const childrenByParent = new Map<string, Set<string>>();
          for (const { file, parent } of pageRoutes(ctx, layers, sources) ?? []) {
            if (!parent?.endsWith(".vue") || parent === file) continue;
            const children = childrenByParent.get(parent) ?? new Set();
            children.add(file);
            childrenByParent.set(parent, children);
          }
          for (const [parent, children] of childrenByParent) {
            graph ??= await ctx.inventory.componentUsage();
            const search = findOutlet(ctx, graph, parent, PAGE_OUTLETS, PAGE_OUTLET_MENTION);
            if (search.state === "absent") report(ctx, parent, [...children]);
          }
        }
      },
    };
  },
});

function report(ctx: RuleContext, parent: string, children: string[]) {
  const text = ctx.fs.readText(parent) ?? "";
  const parentRoute = displayPath(ctx, parent);
  const childList = children
    .slice(0, 3)
    .map((file) => displayPath(ctx, file))
    .join(", ");
  const more = children.length > 3 ? ` and ${children.length - 3} more` : "";
  ctx.report(
    diagnostics.NUXT0098({
      why: `${parentRoute} is the parent route of ${childList}${more}. A child page renders inside its parent's <NuxtPage>, and neither this page nor any component Doctor resolved from its template renders one, so navigating to a child route shows only the parent. Nuxt warns about this at runtime as NUXT_E4016.`,
      fix: `Render <NuxtPage /> in ${parentRoute} where the child page should appear. If the pages should be separate, change the route structure so they are not nested.`,
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
          summary: `No component reachable from ${parentRoute} renders <NuxtPage> or <RouterView>.`,
        },
      ],
      related: children.slice(0, 5).map((file) => ({
        file,
        message: `Child route of ${parentRoute}`,
      })),
    },
  );
}
