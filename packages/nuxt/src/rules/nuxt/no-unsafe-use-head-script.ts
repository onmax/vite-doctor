import { AnyNode, createRule, report } from "./shared.js";

export const noUnsafeUseHeadScript = createRule({
  meta: {
    id: "nuxt/security/no-unsafe-usehead-script",
    title: "Avoid unsafe scripts in useHead",
    category: "security",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/script\s*:|innerHTML|children\s*:/.test(snippet)) return;
        report(
          ctx,
          node,
          "nuxt/security/no-unsafe-usehead-script",
          "error",
          "security",
          "Scripts injected through useHead can bypass safer metadata restrictions.",
          "Use Nuxt Scripts for third-party scripts or useHeadSafe() for constrained head values.",
        );
      },
    };
  },
});
