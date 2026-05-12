import { AnyNode, createRule, report } from "../nuxt/shared.js";

export const noNavigateToInNitro = createRule({
  meta: {
    id: "nitro/context/no-navigateto-in-nitro",
    title: "Do not use navigateTo in Nitro routes",
    description:
      "Nitro handlers should redirect with server response utilities instead of Nuxt app navigation.",
    why: "navigateTo() is a Nuxt app navigation helper. Nitro handlers need to write an HTTP redirect response for the current request event.",
    recommendedReplacement: "Use sendRedirect(event, path) in Nitro handlers.",
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
            "nitro/context/no-navigateto-in-nitro",
            "error",
            "server",
            "navigateTo() is for Nuxt app navigation. Use sendRedirect(event, path) in Nitro handlers.",
          );
      },
    };
  },
});
