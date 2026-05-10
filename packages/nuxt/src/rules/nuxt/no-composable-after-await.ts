import {
  AnyNode,
  NUXT_AUTO_IMPORTS,
  createRule,
  hasPriorAwaitInSameExecutionScope,
  isNuxtRuntimeFile,
  report,
} from "./shared.js";

export const noComposableAfterAwait = createRule({
  meta: {
    id: "nuxt/context/no-composable-after-await",
    title: "Call Nuxt composables before await",
    category: "context",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx)) return;
    const composables = new Set([...NUXT_AUTO_IMPORTS, "useSeoMeta", "useHead", "useHeadSafe"]);
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (!name || !composables.has(name) || !hasPriorAwaitInSameExecutionScope(node)) return;
        report(
          ctx,
          node,
          "nuxt/context/no-composable-after-await",
          "error",
          "context",
          `${name}() is called after await in Nuxt context and may lose async context.`,
          "Call Nuxt composables before the first await or use Nuxt's compiler-aware data factories.",
        );
      },
    };
  },
});
