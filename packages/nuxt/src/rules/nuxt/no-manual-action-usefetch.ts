import { AnyNode, createRule, report } from "./shared.js";
import {
  MUTATING_METHODS,
  asyncDataRuleOptions,
  getAsyncDataCall,
  getDestructuredAsyncDataCommands,
  isWriteLikePath,
} from "./async-data.js";

export const noManualActionUseFetch = createRule({
  meta: {
    id: "nuxt/no-manual-action-usefetch",
    title: "Do not treat immediate:false async data as manual-only",
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
        if (!call || !call.hasImmediateFalse) return;
        const commands = getDestructuredAsyncDataCommands(node);
        const mutating = Boolean(
          call.method &&
          (MUTATING_METHODS.has(call.method) ||
            (call.method === "POST" && isWriteLikePath(call.path, options))),
        );
        if (!mutating && commands.size === 0) return;
        report(
          ctx,
          node,
          "nuxt/no-manual-action-usefetch",
          mutating ? "error" : "warn",
          "fetching",
          mutating
            ? `\`immediate: false\` only disables initial execution. This ${call.method} async-data entry can still run from refreshNuxtData().`
            : "`immediate: false` only disables initial execution. This async-data entry can still run from refreshNuxtData().",
          mutating
            ? "Use $fetch() for event-driven mutations."
            : "Use async data for replay-safe reads, and keep one-shot actions outside Nuxt async-data entries.",
        );
      },
    };
  },
});
