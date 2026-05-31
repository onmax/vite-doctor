import { AnyNode, createRule, report } from "./shared.js";

export const noUseNuxtAppInNitro = createRule({
  meta: {
    id: "nitro/context/no-usenuxtapp-in-nitro",
    title: "Do not use useNuxtApp in Nitro routes",
    description: "Nitro handlers run outside the Nuxt app runtime, so useNuxtApp() is unavailable.",
    why: "Nitro request handlers execute in the server runtime with an event object, not inside Vue or Nuxt app setup. App composables rely on Nuxt app instance state that does not exist there.",
    recommendedReplacement:
      "Use event-aware Nitro, h3, or server utilities that receive the request event.",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "useNuxtApp"))
          report(
            ctx,
            node,
            "nitro/context/no-usenuxtapp-in-nitro",
            "error",
            "server",
            "useNuxtApp() is an app runtime composable and is not available in Nitro handlers. Use event-aware server utilities instead.",
          );
      },
    };
  },
});
