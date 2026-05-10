import { AnyNode, createRule, isAfterAwaitInWatcherCallback, report } from "./shared.js";

export const noOnWatcherCleanupAfterAwait = createRule({
  meta: {
    id: "vue/watch/no-onwatchercleanup-after-await",
    title: "Call onWatcherCleanup synchronously",
    category: "watchers",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "onWatcherCleanup") && isAfterAwaitInWatcherCallback(node)) {
          report(
            ctx,
            node,
            "vue/watch/no-onwatchercleanup-after-await",
            "error",
            "watchers",
            "onWatcherCleanup() must be called synchronously before the first await in the watcher callback.",
          );
        }
      },
    };
  },
});
