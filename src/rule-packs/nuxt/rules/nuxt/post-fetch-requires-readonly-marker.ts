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
    title: "Do not register write-like POST requests as async data",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-fetch#usage",
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
        if (queryLike || !writeLike) return;
        report(
          ctx,
          node,
          "nuxt/post-fetch-requires-readonly-marker",
          "error",
          "fetching",
          `${call.name}() registers a write-like POST request to ${call.path ?? "an unknown endpoint"} as replayable Nuxt async data.`,
          "Use $fetch() for writes. If this endpoint is read-only despite the write-like path, configure readonlyPaths for the Nuxt Doctor module.",
        );
      },
    };
  },
});
