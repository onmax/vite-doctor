import { AnyNode, createRule, report } from "./shared.js";

export const requirePostFlushForDomWatch = createRule({
  meta: {
    id: "vue/watch/require-post-flush-for-dom-read",
    title: "Use post-flush watchers for DOM reads",
    category: "watchers",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (ctx.project.framework === "nuxt" && !isNuxtVueRuntimePath(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "watch")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (
          !/\b(document|window|getBoundingClientRect|offsetWidth|offsetHeight|clientWidth|clientHeight)\b/.test(
            snippet,
          )
        )
          return;
        if (/flush\s*:\s*['"]post['"]/.test(snippet)) return;
        report(
          ctx,
          node,
          "vue/watch/require-post-flush-for-dom-read",
          "warn",
          "watchers",
          "This watcher reads DOM state before Vue has flushed owner DOM updates.",
          "Pass { flush: 'post' } or use watchPostEffect().",
        );
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
