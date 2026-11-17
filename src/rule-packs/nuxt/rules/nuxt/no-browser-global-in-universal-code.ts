import { relative } from "pathe";
import {
  AnyNode,
  BROWSER_GLOBALS,
  createRule,
  replacementForBrowserGlobal,
  report,
} from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";

export const noBrowserGlobalInUniversalCode = createRule({
  meta: {
    id: "nuxt/hydration/no-browser-global-in-universal-code",
    title: "Avoid browser globals in universal code",
    category: "hydration",
    severity: "error",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/best-practices/hydration#browser-only-apis-in-server-context",
    reportScope: "project",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    return {
      Identifier(node: AnyNode) {
        if (!BROWSER_GLOBALS.has(node.name)) return;
        if (!evidence.isActionableUniversalBrowserGlobal(node)) return;
        const caller = evidence.universalBrowserGlobalCaller(node);
        report(
          ctx,
          node,
          "nuxt/hydration/no-browser-global-in-universal-code",
          evidence.universalBrowserGlobalSeverity(node),
          "hydration",
          caller
            ? `${node.name} is browser-only, and ${relative(ctx.project.root, caller.file)}:${caller.line} calls ${caller.callee}() while Nuxt renders on the server.`
            : `${node.name} is browser-only and this file can run during SSR.`,
          replacementForBrowserGlobal(node.name),
          undefined,
          caller
            ? [caller, ...(caller.via ?? [])].map((site) => ({
                file: site.file,
                range: site.range,
                message: `SSR call to ${site.callee}()`,
              }))
            : undefined,
        );
      },
    };
  },
});
