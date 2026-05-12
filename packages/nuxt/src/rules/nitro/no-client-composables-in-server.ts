import { AnyNode, createRule, report } from "../nuxt/shared.js";

export const noClientComposablesInServer = createRule({
  meta: {
    id: "nitro/server/no-client-composables",
    title: "Do not use app composables in Nitro server files",
    description: "Nuxt app composables are not available from Nitro server files.",
    why: "Server handlers run with Nitro request context, not Vue setup context. App composables like useRoute(), useFetch(), and useHead() depend on the Nuxt app runtime.",
    recommendedReplacement: "Use event-aware Nitro utilities in server handlers.",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    const clientComposables = new Set([
      "useRoute",
      "useRouter",
      "useState",
      "useFetch",
      "useAsyncData",
      "useHead",
      "useSeoMeta",
    ]);
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (!name || !clientComposables.has(name)) return;
        report(
          ctx,
          node,
          "nitro/server/no-client-composables",
          "error",
          "server",
          `${name}() is a Nuxt app composable and is not available in Nitro server files.`,
          "Use event-aware Nitro utilities in server handlers.",
        );
      },
    };
  },
});
