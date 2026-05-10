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
