import { AnyNode, createRule, report } from "./shared.js";

export const noAwaitInsideCustomWrapper = createRule({
  meta: {
    id: "nuxt/fetch/no-await-inside-custom-wrapper",
    title: "Do not await inside custom useFetch/useAsyncData wrappers",
    category: "fetching",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-fetch#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (
          node.type === "AwaitExpression" &&
          ["useFetch", "useAsyncData"].includes(ctx.helpers.getCalleeName(node.argument) ?? "")
        ) {
          const text = ctx.file.text.slice(Math.max(0, node.start - 80), node.start);
          if (/function\s+use[A-Z]\w+|const\s+use[A-Z]\w+\s*=/.test(text)) {
            report(
              ctx,
              node,
              "nuxt/fetch/no-await-inside-custom-wrapper",
              "error",
              "fetching",
              "Custom wrappers around useFetch/useAsyncData should return the composable directly. Awaiting inside the wrapper can break Nuxt async context behavior.",
              "Return the useFetch/useAsyncData promise directly from the custom wrapper.",
            );
          }
        }
      },
    };
  },
});
