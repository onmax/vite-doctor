import { AnyNode, createRule, report } from "./shared.js";

export const preferUseHeadSafeForUntrustedValues = createRule({
  meta: {
    id: "nuxt/security/prefer-useheadsafe-for-untrusted-values",
    title: "Use useHeadSafe for untrusted head values",
    category: "security",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/(route\.|params|query|user|content|markdown|html)/i.test(snippet)) return;
        report(
          ctx,
          node,
          "nuxt/security/prefer-useheadsafe-for-untrusted-values",
          "warn",
          "security",
          "Head values derived from route, content, or user data should be constrained.",
          "Use useHeadSafe() or sanitize the value before passing it to useHead().",
        );
      },
    };
  },
});
