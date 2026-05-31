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
    if (ctx.project.framework === "nuxt" && !isNuxtVueRuntimePath(ctx.file.relativePath)) return;
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
          hasCleanup ||
          returnsLongLivedResource(ctx.file.text)
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

function returnsLongLivedResource(source: string) {
  const resource =
    /\bconst\s+(\w+)\s*=\s*new\s+(?:ResizeObserver|IntersectionObserver|WebSocket)\b/.exec(source);
  return Boolean(resource?.[1] && new RegExp(`\\breturn\\s+${resource[1]}\\b`).test(source));
}

function isNuxtVueRuntimePath(path: string) {
  if (
    path.includes(".client.") ||
    /\.(md|mdc|markdown)$/.test(path) ||
    /^(content|server|app\/server|shared\/types|generated|app\/generated)\//.test(path)
  )
    return false;
  return /^(app\/)?(components|composables|layouts|middleware|pages|plugins|utils)\//.test(path);
}
