import { AnyNode, createRule, report } from "./shared.js";

export const noNavigateToInNitro = createRule({
  meta: {
    id: "nuxt/context/no-navigateto-in-nitro",
    title: "Do not use navigateTo in Nitro routes",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "navigateTo"))
          report(
            ctx,
            node,
            "nuxt/context/no-navigateto-in-nitro",
            "error",
            "server",
            "navigateTo() is for Nuxt app navigation. Use sendRedirect(event, path) in Nitro handlers.",
          );
      },
    };
  },
});
