import { AnyNode, createRule, report } from "./shared.js";

export const noClientComposablesInServer = createRule({
  meta: {
    id: "nuxt/server/no-client-composables",
    title: "Do not use app composables in Nitro server files",
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
          "nuxt/server/no-client-composables",
          "error",
          "server",
          `${name}() is a Nuxt app composable and is not available in Nitro server files.`,
          "Use event-aware Nitro utilities in server handlers.",
        );
      },
    };
  },
});
