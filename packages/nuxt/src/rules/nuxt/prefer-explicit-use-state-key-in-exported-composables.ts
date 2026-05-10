import { AnyNode, createRule, isInsideExportedFunction, report } from "./shared.js";

export const preferExplicitUseStateKeyInExportedComposables = createRule({
  meta: {
    id: "nuxt/state/prefer-explicit-usestate-key-in-exported-composables",
    title: "Use explicit useState keys in exported composables",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/(^|\/)(composables|utils|shared)\//.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useState")) return;
        if (typeof node.arguments?.[0]?.value === "string") return;
        if (!isInsideExportedFunction(ctx.file.text, node.start)) return;
        report(
          ctx,
          node,
          "nuxt/state/prefer-explicit-usestate-key-in-exported-composables",
          "warn",
          "hydration",
          "Exported composables should not rely on generated useState keys because callsite location can change.",
          "Pass an explicit stable key as the first useState() argument.",
        );
      },
    };
  },
});
