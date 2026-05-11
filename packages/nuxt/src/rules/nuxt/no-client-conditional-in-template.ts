import { AnyNode, createRule, isClientOnlyPath, isNuxtRuntimeFile, report } from "./shared.js";

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
        const expressions = conditionalExpressions(node, ctx.file.text);
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

function conditionalExpressions(node: AnyNode, source: string): string[] {
  return (node.startTag?.attributes ?? [])
    .filter(
      (attr: AnyNode) =>
        attr.directive &&
        (attr.key?.name?.name === "if" ||
          attr.key?.name?.name === "else-if" ||
          attr.key?.name?.name === "show"),
    )
    .map((attr: AnyNode) => {
      const expression = attr.value?.expression;
      if (!expression) return "";
      if (expression.raw) return String(expression.raw);
      if (expression.start != null && expression.end != null)
        return source.slice(expression.start, expression.end);
      return "";
    });
}
