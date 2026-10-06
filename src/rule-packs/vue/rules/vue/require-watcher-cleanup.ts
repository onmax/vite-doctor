import { createRule, report } from "./shared.js";
import { uncleanedWatcherResources } from "./resource-cleanup-evidence.js";

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
      Program() {
        for (const resource of uncleanedWatcherResources(ctx)) {
          report(
            ctx,
            resource,
            "vue/watch/require-side-effect-cleanup",
            "warn",
            "watchers",
            "This watcher creates a side effect without registering cleanup.",
            "Register cleanup for this resource with onWatcherCleanup() or the watcher onCleanup argument.",
          );
        }
      },
    };
  },
});
