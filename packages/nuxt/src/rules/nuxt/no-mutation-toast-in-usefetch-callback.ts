import { AnyNode, createRule, report } from "./shared.js";
import {
  FETCH_ASYNC_DATA_COMPOSABLES,
  MUTATING_METHODS,
  asyncDataRuleOptions,
  collectReplayableSideEffects,
  getAsyncDataCall,
  getObjectPropertyValue,
  isWriteLikePath,
} from "./async-data.js";

const CALLBACK_KEYS = ["onRequest", "onResponse", "onRequestError", "onResponseError"];

export const noMutationToastInUseFetchCallback = createRule({
  meta: {
    id: "nuxt/no-mutation-toast-in-usefetch-callback",
    title: "Keep useFetch lifecycle callbacks replay-safe",
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
        if (!call || !FETCH_ASYNC_DATA_COMPOSABLES.has(call.name) || !call.options) return;
        const mutating = Boolean(
          call.method &&
          (MUTATING_METHODS.has(call.method) ||
            (call.method === "POST" && isWriteLikePath(call.path, options))),
        );
        for (const key of CALLBACK_KEYS) {
          const callback = getObjectPropertyValue(call.options, key);
          if (!callback) continue;
          const effect = collectReplayableSideEffects(ctx, callback)[0];
          if (!effect) continue;
          report(
            ctx,
            effect.node,
            "nuxt/no-mutation-toast-in-usefetch-callback",
            mutating ? "error" : "warn",
            "fetching",
            mutating
              ? `${call.name} ${call.method} lifecycle callbacks are part of a replayable async-data request.`
              : `${call.name} lifecycle callbacks are part of a replayable async-data request.`,
            "Move toasts, refreshes, navigation, and store writes into the explicit action around $fetch().",
          );
          return;
        }
      },
    };
  },
});
