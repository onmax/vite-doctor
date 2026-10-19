import { AnyNode, createRule, report } from "./shared.js";
import {
  MUTATING_METHODS,
  asyncDataRuleOptions,
  fileMayCallAsyncData,
  getAsyncDataCall,
  getDestructuredAsyncDataCommands,
  hasReadonlyEvidence,
  isWriteLikePath,
} from "./async-data.js";

export const noManualActionUseFetch = createRule({
  meta: {
    id: "nuxt/no-manual-action-usefetch",
    title: "Do not treat immediate:false async data as manual-only",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/getting-started/data-fetching#refresh-and-execute",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!fileMayCallAsyncData(ctx)) return;
    const options = asyncDataRuleOptions(ctx);
    return {
      CallExpression(node: AnyNode) {
        const call = getAsyncDataCall(ctx, node);
        if (!call || !call.hasImmediateFalse) return;
        const mutating = Boolean(call.method && MUTATING_METHODS.has(call.method));
        if (!mutating && hasReadonlyEvidence(ctx, call, options)) return;
        const write = mutating || (call.method === "POST" && isWriteLikePath(call.path, options));
        if (!write && getDestructuredAsyncDataCommands(node).size === 0) return;
        report(
          ctx,
          node,
          "nuxt/no-manual-action-usefetch",
          write ? "error" : "warn",
          "fetching",
          write
            ? `\`immediate: false\` only disables initial execution. This ${call.method} async-data entry can still run from refreshNuxtData().`
            : "`immediate: false` only disables initial execution. This async-data entry can still run from refreshNuxtData().",
          write
            ? "Use $fetch() for event-driven mutations."
            : "Use async data for replay-safe reads, and keep one-shot actions outside Nuxt async-data entries.",
        );
      },
    };
  },
});
