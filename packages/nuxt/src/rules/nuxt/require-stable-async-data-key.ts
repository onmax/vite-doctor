import {
  AnyNode,
  createRule,
  isObviouslyUnstableKeyNode,
  isStableKeyNode,
  report,
} from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";

export const requireStableAsyncDataKey = createRule({
  meta: {
    id: "nuxt/fetch/require-stable-asyncdata-key",
    title: "Use stable keys for async data payload entries",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useAsyncData") && !ctx.helpers.isCall(node, "useFetch"))
          return;
        const first = node.arguments?.[0];
        if (!first) return;
        if (first.type === "ArrowFunctionExpression" || first.type === "FunctionExpression") {
          if (!evidence.isReusableDataComposable(node)) return;
          report(
            ctx,
            node,
            "nuxt/fetch/require-stable-asyncdata-key",
            "warn",
            "fetching",
            "This keyed composable relies on a generated location key.",
            "Pass an explicit stable key before the data handler when data may be shared, prerendered, or wrapped.",
          );
          return;
        }
        if (!isStableKeyNode(first) && isObviouslyUnstableKeyNode(first, ctx.file.text)) {
          report(
            ctx,
            first,
            "nuxt/fetch/require-stable-asyncdata-key",
            "warn",
            "fetching",
            "This async data key is dynamic and may not resolve to the same payload entry across builds or prerenders.",
            "Use a stable string key derived from route params or explicit inputs.",
          );
        }
      },
    };
  },
});
