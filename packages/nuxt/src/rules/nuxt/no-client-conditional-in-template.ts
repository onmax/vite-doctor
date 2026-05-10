import {
  AnyNode,
  createRule,
  isClientOnlyPath,
  isNuxtRuntimeFile,
  report,
  templateExpressions,
} from "./shared.js";

export const noClientConditionalInTemplate = createRule({
  meta: {
    id: "nuxt/hydration/no-client-conditional-in-template",
    title: "Avoid client-only conditionals in SSR templates",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    if (
      !isNuxtRuntimeFile(ctx) ||
      isClientOnlyPath(ctx.file.relativePath) ||
      ctx.helpers.isNuxtServerFile(ctx.file.relativePath)
    )
      return;
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement") return;
        const expressions = templateExpressions(node, ctx.file.text);
        if (
          !expressions.some((text) =>
            /\b(import\.meta\.client|process\.client|window|document|navigator)\b/.test(text),
          )
        )
          return;
        report(
          ctx,
          node,
          "nuxt/hydration/no-client-conditional-in-template",
          "warn",
          "hydration",
          "This template branches on client-only state during SSR and can hydrate to different markup.",
          "Prefer CSS breakpoints, <ClientOnly>, or initialize SSR-safe state before rendering.",
        );
      },
    };
  },
});
