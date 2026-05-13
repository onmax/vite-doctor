import { AnyNode, createRule, report } from "./shared.js";
import { FETCH_ASYNC_DATA_COMPOSABLES, MUTATING_METHODS, getAsyncDataCall } from "./async-data.js";

export const asyncDataNoMutationMethods = createRule({
  meta: {
    id: "nuxt/async-data-no-mutation-methods",
    title: "Do not register mutating requests as async data",
    category: "fetching",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const call = getAsyncDataCall(ctx, node);
        if (!call || !FETCH_ASYNC_DATA_COMPOSABLES.has(call.name)) return;
        if (!call.method || !MUTATING_METHODS.has(call.method)) return;
        report(
          ctx,
          node,
          "nuxt/async-data-no-mutation-methods",
          "error",
          "fetching",
          `${call.name}() registers a ${call.method} request as replayable Nuxt async data.`,
          "Use $fetch() for user-triggered writes. Keep useFetch() for replay-safe reads.",
        );
      },
    };
  },
});
