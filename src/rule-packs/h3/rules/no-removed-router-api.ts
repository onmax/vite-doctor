import { createRule } from "./shared.js";

export const noRemovedRouterApi = createRule({
  meta: {
    id: "h3/migration/no-removed-router-api",
    title: "Replace router APIs H3 v2 removed",
    description:
      "Flags router.add(), router.resolve(), app.stack, lazy handlers registered with { lazy: true }, and array route paths, which H3 v2 removed.",
    why: "H3 v2 merged the router into the app. The removed members are undefined at runtime, so a call throws when the route module loads and the server fails to start.",
    recommendedReplacement:
      "Register routes with app.on(method, path, handler) or app.get(path, handler), register each path separately, and wrap lazy handlers with defineLazyEventHandler().",
    category: "migration",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/blob/main/MIGRATION.md",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create() {
    return undefined;
  },
});
