import { AnyNode, createRule, report } from "./shared.js";

export const noRawFetchInSetup = createRule({
  meta: {
    id: "nuxt/fetch/no-raw-fetch-in-setup",
    title: "Use Nuxt data fetching primitives for SSR render data",
    category: "fetching",
    severity: "warn",
    fixable: false,
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const appSurface =
      ctx.file.isVueSfc &&
      (ctx.file.inAppDir("pages") ||
        ctx.file.inAppDir("components") ||
        ctx.file.inAppDir("layouts"));
    if (!appSurface) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "AwaitExpression") return;
        const call = node.argument;
        const name = ctx.helpers.getCalleeName(call);
        if (name === "$fetch" || name === "fetch" || name === "axios.get") {
          report(
            ctx,
            call,
            "nuxt/fetch/no-raw-fetch-in-setup",
            "warn",
            "fetching",
            "This fetch runs in setup for SSR-rendered data. Use useFetch() or useAsyncData() to avoid duplicate fetching and hydration issues.",
            "Replace with await useFetch(...) or await useAsyncData(key, () => $fetch(...)).",
          );
        }
      },
    };
  },
});
