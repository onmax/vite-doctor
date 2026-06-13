import { AnyNode, createRule, report } from "./shared.js";

export const noUseRouteInMiddleware = createRule({
  meta: {
    id: "nuxt/routing/no-useroute-in-middleware",
    title: "Use middleware to/from arguments instead of useRoute",
    category: "routing",
    severity: "error",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/directory-structure/app/middleware#accessing-route-in-middleware",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !ctx.file.relativePath.includes("/middleware/") &&
      !ctx.file.relativePath.startsWith("middleware/") &&
      !ctx.file.relativePath.startsWith("app/middleware/")
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "useRoute")) {
          report(
            ctx,
            node,
            "nuxt/routing/no-useroute-in-middleware",
            "error",
            "routing",
            "Route middleware receives to/from route arguments. useRoute() can point at the previous route in this context.",
            "Read route data from the to/from middleware arguments instead of useRoute().",
          );
        }
      },
    };
  },
});
