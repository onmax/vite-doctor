import { AnyNode, createRule, report } from "./shared.js";

export const noUseNuxtAppInNitro = createRule({
  meta: {
    id: "nuxt/context/no-usenuxtapp-in-nitro",
    title: "Do not use useNuxtApp in Nitro routes",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "useNuxtApp"))
          report(
            ctx,
            node,
            "nuxt/context/no-usenuxtapp-in-nitro",
            "error",
            "server",
            "useNuxtApp() is an app runtime composable and is not available in Nitro handlers. Use event-aware server utilities instead.",
          );
      },
    };
  },
});
