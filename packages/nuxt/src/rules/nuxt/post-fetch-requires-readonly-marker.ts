import { AnyNode, createRule, report } from "./shared.js";
import {
  FETCH_ASYNC_DATA_COMPOSABLES,
  asyncDataRuleOptions,
  getAsyncDataCall,
  isQueryLikePath,
  isReadonlyPath,
  isWriteLikePath,
} from "./async-data.js";

export const postFetchRequiresReadonlyMarker = createRule({
  meta: {
    id: "nuxt/post-fetch-requires-readonly-marker",
    title: "Mark POST async data requests as readonly",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const options = asyncDataRuleOptions(ctx);
    return {
      ScriptNode(node: AnyNode) {
        const call = getAsyncDataCall(ctx, node);
        if (!call || !FETCH_ASYNC_DATA_COMPOSABLES.has(call.name)) return;
        if (call.method !== "POST" || call.readonlyMarked || isReadonlyPath(call.path, options))
          return;
        const queryLike = isQueryLikePath(call.path);
        const writeLike = isWriteLikePath(call.path, options);
        report(
          ctx,
          node,
          "nuxt/post-fetch-requires-readonly-marker",
          writeLike && !queryLike ? "error" : "warn",
          "fetching",
          `${call.name}() registers a POST request to ${call.path ?? "an unknown endpoint"} as replayable Nuxt async data without a readonly marker.`,
          "Add meta: { readonly: true } or a nuxt-doctor: async-data-readonly comment for read-like POST queries. Use $fetch() for writes.",
        );
      },
    };
  },
});
