import { AnyNode, createRule, report } from "./shared.js";

export const requireWatcherCleanup = createRule({
  meta: {
    id: "vue/watch/require-side-effect-cleanup",
    title: "Clean up watcher side effects",
    category: "watchers",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/watchers.html#side-effect-cleanup",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "watch") && !ctx.helpers.isCall(node, "watchEffect")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (
          !/(addEventListener|setInterval|setTimeout|new\s+(ResizeObserver|IntersectionObserver|WebSocket))/.test(
            snippet,
          )
        )
          return;
        if (
          /(onCleanup|onWatcherCleanup|onScopeDispose|removeEventListener|clearInterval|clearTimeout|disconnect|close)\s*\(/.test(
            snippet,
          )
        )
          return;
        report(
          ctx,
          node,
          "vue/watch/require-side-effect-cleanup",
          "warn",
          "watchers",
          "This watcher creates a side effect without registering cleanup.",
          "Use onWatcherCleanup(), the watcher onCleanup argument, or onScopeDispose().",
        );
      },
    };
  },
});
