import {
  h3AppMethod,
  isKnownMiddleware,
  mayReferenceH3App,
  staticString,
} from "./_migration-helpers.js";
import { type AnyNode, createRule, report } from "./shared.js";

const ruleId = "h3/middleware/no-exact-path-use";

// Copied from h3 2.0.8 dist/middleware.mjs: a route this pattern matches is compared to the
// request path for equality, ignoring one trailing slash, instead of as a prefix.
const literalRoute = /^(?:\/[^/:*(){}\\?^\0- "#<>`\x7F-￿]+)*\/?$/;

export const noExactPathUse = createRule({
  meta: {
    id: ruleId,
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
  create(ctx) {
    if (!mayReferenceH3App(ctx)) return;
    return {
      CallExpression(node: AnyNode) {
        const [pathArgument, middleware] = node.arguments ?? [];
        const path = staticString(pathArgument);
        // An empty path registers global middleware, as app.use(fn) does.
        if (!path || !middleware) return;
        const route = path.startsWith("/") ? path : `/${path}`;
        if (!literalRoute.test(route)) return;
        if (h3AppMethod(ctx, node) !== "use") return;
        // A sub-app passed to use() is mounted under the path, which keeps prefix matching.
        if (!isKnownMiddleware(ctx, middleware)) return;
        const base = route.replace(/\/$/, "");
        report(
          ctx,
          pathArgument,
          ruleId,
          "warn",
          "middleware",
          base
            ? `H3 v2 runs app.use("${path}", middleware) only for ${base} itself, not for paths under it.`
            : `H3 v2 runs app.use("${path}", middleware) only for the root path, not for every request.`,
          base
            ? `Use "${base}/**" to run it for every path under ${base}, or keep "${path}" if it is meant for that one route.`
            : "Call app.use(middleware) without a path to run it for every request.",
        );
      },
    };
  },
});
