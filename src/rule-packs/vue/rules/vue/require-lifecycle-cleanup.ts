import { createRule, report } from "./shared.js";
import { uncleanedLifecycleResources } from "./resource-cleanup-evidence.js";

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
    if (ctx.project.framework === "nuxt" && !isNuxtVueRuntimePath(ctx.file.relativePath)) return;
    return {
      Program() {
        for (const resource of uncleanedLifecycleResources(ctx)) {
          report(
            ctx,
            resource,
            "vue/lifecycle/require-cleanup",
            "warn",
            "lifecycle",
            "This component creates a long-lived browser resource without lifecycle cleanup.",
            "Register cleanup for this resource with onUnmounted() or onScopeDispose().",
          );
        }
      },
    };
  },
});

function isNuxtVueRuntimePath(path: string) {
  if (
    path.includes(".client.") ||
    /\.(md|mdc|markdown)$/.test(path) ||
    /^(content|server|app\/server|shared\/types|generated|app\/generated)\//.test(path)
  )
    return false;
  return /^(app\/)?(components|composables|layouts|middleware|pages|plugins|utils)\//.test(path);
}
