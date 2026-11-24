import type { RuleContext } from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { createRule } from "./shared.js";
import {
  displayPath,
  findOutlet,
  LAYOUT_OUTLETS,
  LAYOUT_OUTLET_MENTION,
  mainApp,
  nuxtLayerSources,
  pageRoutes,
  PAGE_OUTLETS,
  PAGE_OUTLET_MENTION,
  registeredLayouts,
  templateTagRange,
} from "./page-structure.js";

const RULE_ID = "nuxt/layouts/app-renders-nuxtlayout";

export const appRendersNuxtLayout = createRule({
  meta: {
    id: RULE_ID,
    title: "Render NuxtLayout when the app has layouts",
    category: "routing",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/directory-structure/app/layouts#enable-layouts",
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
        for (const layers of nuxtLayerSources(ctx)) {
          const layouts = registeredLayouts(ctx, layers, sources);
          if (!layouts?.length) continue;
          const app = mainApp(ctx, layers);
          if (!app?.endsWith(".vue")) continue;
          const graph = await ctx.inventory.componentUsage();
          const routes = pageRoutes(ctx, layers, sources);
          const queue = [app];
          const seen = new Set<string>();
          let absent = true;
          for (const file of queue) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (
              findOutlet(ctx, graph, file, LAYOUT_OUTLETS, LAYOUT_OUTLET_MENTION).state !== "absent"
            ) {
              absent = false;
              break;
            }
            const page = findOutlet(ctx, graph, file, PAGE_OUTLETS, PAGE_OUTLET_MENTION);
            if (page.state === "absent") continue;
            if (!routes || page.state === "unknown") {
              absent = false;
              break;
            }
            queue.push(
              ...routes
                .filter((route) => route.parent === (file === app ? null : file))
                .map((route) => route.file),
            );
          }
          if (absent)
            report(
              ctx,
              app,
              layouts.map((layout) => layout.file),
            );
        }
      },
    };
  },
});

function report(ctx: RuleContext, app: string, layouts: string[]) {
  const text = ctx.fs.readText(app) ?? "";
  const appPath = displayPath(ctx, app);
  const names = layouts
    .slice(0, 3)
    .map((file) => displayPath(ctx, file))
    .join(", ");
  const more = layouts.length > 3 ? ` and ${layouts.length - 3} more` : "";
  ctx.report(
    diagnostics.NUXT0099({
      why: `The app has layouts (${names}${more}), but no component reachable from ${appPath} renders <NuxtLayout>. Nuxt renders layouts only through <NuxtLayout>, so the registered layouts are ignored. Nuxt warns about this at runtime as NUXT_E4007.`,
      fix: `Wrap the app's <NuxtPage /> in <NuxtLayout> in ${appPath}, or remove the unused layouts.`,
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "routing",
      file: app,
      range: templateTagRange(ctx, app, text),
      confidence: "heuristic-high",
      evidence: [
        {
          kind: "graph",
          file: app,
          summary: `No component reachable from ${appPath} renders <NuxtLayout>.`,
        },
      ],
      related: layouts.slice(0, 5).map((file) => ({ file, message: "Layout Nuxt never renders" })),
    },
  );
}
