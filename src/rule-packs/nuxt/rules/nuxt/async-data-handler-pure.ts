import { AnyNode, createRule, report } from "./shared.js";
import {
  asyncDataRuleOptions,
  collectReplayableSideEffects,
  getAsyncDataCall,
  isQueryLikePath,
  isReadonlyPath,
  isWriteLikePath,
  replayableSeverity,
} from "./async-data.js";

export const asyncDataHandlerPure = createRule({
  meta: {
    id: "nuxt/async-data-handler-pure",
    title: "Keep async data handlers replay-safe",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-async-data#params",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const call = getAsyncDataCall(ctx, node);
        if (!call?.handler) return;
        const options = asyncDataRuleOptions(ctx);
        for (const effect of collectReplayableSideEffects(ctx, call.handler)) {
          const isMutatingFetch = effect.kind === "mutating-fetch";
          const effectPath = effect.path ?? call.path;
          if (
            isMutatingFetch &&
            effect.method === "POST" &&
            (call.readonlyMarked ||
              isReadonlyPath(effectPath, options) ||
              (isQueryLikePath(effectPath) && !isWriteLikePath(effectPath, options)))
          )
            continue;
          report(
            ctx,
            effect.node,
            "nuxt/async-data-handler-pure",
            replayableSeverity(effect.confidence),
            "fetching",
            isMutatingFetch
              ? "This async-data handler performs a mutating $fetch() request that can replay."
              : "This async-data handler performs a side effect that can replay.",
            "Return data from the handler. Move effects to explicit event handlers, callOnce(), or guarded watchers.",
          );
          break;
        }
      },
    };
  },
});
