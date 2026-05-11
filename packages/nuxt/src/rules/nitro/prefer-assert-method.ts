import { type AnyNode, createRule, report } from "../nuxt/shared.js";
import { isSingleMethodCheck } from "./request-helpers.js";

export const preferAssertMethod = createRule({
  meta: {
    id: "nitro/request/prefer-assert-method",
    title: "Use assertMethod for single-method handlers",
    description:
      "Single-method Nitro handlers should use the H3 method assertion helper instead of ad hoc method checks.",
    recommendedReplacement:
      'Use assertMethod(event, "POST") for handlers that accept one HTTP method.',
    category: "request",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        const method = isSingleMethodCheck(node, ctx.file.text);
        if (!method) return;
        report(
          ctx,
          node,
          "nitro/request/prefer-assert-method",
          "info",
          "request",
          `This handler checks for ${method} manually.`,
          `Use assertMethod(event, "${method}") for single-method Nitro handlers.`,
        );
      },
    };
  },
});
