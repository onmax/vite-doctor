import { AnyNode, createRule, report } from "./shared.js";

export const requireLifecycleCleanup = createRule({
  meta: {
    id: "vue/lifecycle/require-cleanup",
    title: "Clean up lifecycle resources",
    category: "lifecycle",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    let hasCleanup = false;
    return {
      ScriptNode(node: AnyNode) {
        if (
          ctx.helpers.isCall(node, "onUnmounted") ||
          ctx.helpers.isCall(node, "onBeforeUnmount") ||
          ctx.helpers.isCall(node, "onScopeDispose")
        )
          hasCleanup = true;
        if (node.type !== "Program") return;
        if (
          !/(setInterval|addEventListener|new\s+(ResizeObserver|IntersectionObserver|WebSocket))/.test(
            ctx.file.text,
          )
        )
          return;
        if (
          /(clearInterval|removeEventListener|disconnect|close)\s*\(/.test(ctx.file.text) ||
          hasCleanup
        )
          return;
        report(
          ctx,
          node,
          "vue/lifecycle/require-cleanup",
          "warn",
          "lifecycle",
          "This component creates a long-lived browser resource without lifecycle cleanup.",
          "Register cleanup with onUnmounted() or onScopeDispose().",
        );
      },
    };
  },
});
