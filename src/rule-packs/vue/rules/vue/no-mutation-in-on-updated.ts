import { AnyNode, createRule, report } from "./shared.js";

export const noMutationInOnUpdated = createRule({
  meta: {
    id: "vue/lifecycle/no-mutation-in-onupdated",
    title: "Do not mutate state in onUpdated",
    category: "lifecycle",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/api/composition-api-lifecycle.html#onupdated",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "onUpdated")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/(\.value\s*=|\+\+|--|\.push\s*\(|\.splice\s*\(|=)/.test(snippet)) return;
        report(
          ctx,
          node,
          "vue/lifecycle/no-mutation-in-onupdated",
          "error",
          "lifecycle",
          "Mutating reactive state in onUpdated can create update loops.",
          "Move the mutation to the event or watcher that caused the update.",
        );
      },
    };
  },
});
