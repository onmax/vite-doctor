import { basename } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { createRule } from "./shared.js";
import {
  displayPath,
  findOutlet,
  isInsideDir,
  isScannedNuxtFile,
  nuxtLayerSources,
  pascalTag,
  templateTagRange,
  unreadLayers,
} from "./page-structure.js";

const RULE_ID = "nuxt/layouts/app-renders-nuxtlayout";
const LAYOUT_OUTLETS = new Set(["NuxtLayout"]);
const LAYOUT_OUTLET_MENTION = /\b(?:NuxtLayout|nuxt-layout)\b/;
// Nuxt resolves the main component as `App` or `app` with any of its extensions.
const APP_COMPONENT = /^[Aa]pp\.(?:vue|[cm]?[jt]sx?)$/;

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
          const layouts = layers.flatMap((layer) =>
            sources.filter(
              (file) => isInsideDir(file, `${layer.srcDir}/layouts`) && isScannedNuxtFile(file),
            ),
          );
          if (!layouts.length) continue;
          // The first layer with an app component wins. Without one, Nuxt's default app renders
          // <NuxtLayout>.
          const owner = layers.find((layer) =>
            (ctx.fs.readDir(layer.srcDir) ?? []).some(
              (entry) => entry.isFile() && APP_COMPONENT.test(entry.name),
            ),
          );
          // The root layer's app component always wins; another one may lose to a layer Doctor
          // cannot read.
          if (!owner || (owner !== layers[0] && unreadLayers(ctx, layers))) continue;
          const app = sources.find(
            (file) =>
              file.startsWith(`${owner.srcDir}/`) &&
              !file.slice(owner.srcDir.length + 1).includes("/") &&
              APP_COMPONENT.test(basename(file)),
          );
          if (!app?.endsWith(".vue")) continue;
          const graph = await ctx.inventory.componentUsage();
          // Nuxt's runtime check passes once any <NuxtLayout> renders, so a page that renders its
          // own layout, or an app shell Doctor cannot follow, is not reported.
          const usedElsewhere = [...graph.components.values()].some(
            (node) =>
              !/^error\.vue$/.test(basename(node.file)) &&
              node.facts.usages.some((usage) => LAYOUT_OUTLETS.has(pascalTag(usage.tag))),
          );
          if (usedElsewhere) continue;
          const search = findOutlet(ctx, graph, app, LAYOUT_OUTLETS, LAYOUT_OUTLET_MENTION);
          if (search.state !== "absent") continue;
          report(ctx, app, layouts);
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
      why: `The app has layouts (${names}${more}), but ${appPath} does not render <NuxtLayout>, and no other component in the project does. Nuxt renders layouts only through <NuxtLayout>, so every layout is ignored, including layouts/default.vue and the layout pages choose with definePageMeta({ layout }). Nuxt warns about this at runtime as NUXT_E4007.`,
      fix: `Wrap the app's <NuxtPage /> in <NuxtLayout> in ${appPath}. If the app does not use layouts, delete the layouts/ directory.`,
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
