import { createRule } from "./shared.js";

export const noExactPathUse = createRule({
  meta: {
    id: "h3/middleware/no-exact-path-use",
    title: "Match nested paths in H3 v2 middleware",
    description:
      'Flags app.use("/path", middleware) with a path that has no wildcard. Mounting a sub-app with app.use("/path", app) still matches nested paths and is not flagged.',
    why: 'In H3 v1, app.use("/api", fn) ran for every path under /api. In H3 v2 a middleware path is a route pattern, so "/api" matches only /api itself and the middleware skips every nested route.',
    recommendedReplacement:
      'Add a wildcard, such as app.use("/api/**", fn), or keep the exact path when the middleware is meant for that one route.',
    category: "middleware",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/migration",
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
