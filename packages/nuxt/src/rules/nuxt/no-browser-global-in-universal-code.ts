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
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/best-practices/hydration#browser-only-apis-in-server-context",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Identifier" || !BROWSER_GLOBALS.has(node.name)) return;
        if (!evidence.isActionableUniversalBrowserGlobal(node)) return;
        report(
          ctx,
          node,
          "nuxt/hydration/no-browser-global-in-universal-code",
          evidence.universalBrowserGlobalSeverity(node),
          "hydration",
          `${node.name} is browser-only and this file can run during SSR.`,
          replacementForBrowserGlobal(node.name),
        );
      },
    };
  },
});
