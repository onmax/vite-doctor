import { AnyNode, createRule, isInsideExportedFunction, report } from "./shared.js";

export const preferCreateUseFetch = createRule({
  meta: {
    id: "nuxt/fetch/prefer-create-use-fetch",
    title: "Prefer Nuxt data factories for custom data composables",
    category: "fetching",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/(^|\/)(composables|utils)\//.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useFetch") && !ctx.helpers.isCall(node, "useAsyncData"))
          return;
        if (!isInsideExportedFunction(ctx.file.text, node.start)) return;
        report(
          ctx,
          node,
          "nuxt/fetch/prefer-create-use-fetch",
          "info",
          "fetching",
          "Exported custom data composables should use Nuxt's compiler-aware data factories.",
          "Use createUseFetch() or createUseAsyncData() for reusable keyed data composables.",
        );
      },
    };
  },
});
