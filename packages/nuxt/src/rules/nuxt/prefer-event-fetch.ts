import { AnyNode, createRule, report } from "./shared.js";

export const preferEventFetch = createRule({
  meta: {
    id: "nuxt/server/prefer-event-fetch",
    title: "Use event.$fetch in Nitro handlers",
    category: "server",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "$fetch")) return;
        report(
          ctx,
          node,
          "nuxt/server/prefer-event-fetch",
          "warn",
          "server",
          "$fetch() in Nitro handlers does not automatically carry request event context.",
          "Use event.$fetch() when proxying to other server routes.",
        );
      },
    };
  },
});
