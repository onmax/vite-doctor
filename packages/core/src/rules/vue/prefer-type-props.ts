import { AnyNode, createRule } from "./shared.js";

interface Options {
  allowRuntimeValidators?: boolean;
}

export const preferTypeProps = createRule({
  meta: {
    id: "vue/style/prefer-type-props",
    title: "Prefer TypeScript props declarations",
    category: "style",
    severity: "warn",
    fixable: "suggestion",
    requires: { sfc: true, script: true, vue: true },
  },
  create(ctx) {
    const options = (ctx.options ?? {}) as Options;
    if (options.allowRuntimeValidators || !isTypeScriptScriptSetup(ctx.file.text)) return;

    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "defineProps")) return;
        if (!node.arguments?.length || hasTypeParameters(node)) return;
        ctx.report({
          ruleId: "vue/style/prefer-type-props",
          severity: ctx.severity,
          category: "style",
          file: ctx.file.path,
          range: ctx.range(node),
          message:
            "TypeScript <script setup> components should declare props with a type argument.",
          suggestion: "Use defineProps<Props>() instead of a runtime props declaration.",
        });
      },
    };
  },
});

function isTypeScriptScriptSetup(source: string): boolean {
  return /<script\b(?=[^>]*\bsetup\b)(?=[^>]*\blang=["']ts["'])/i.test(source);
}

function hasTypeParameters(node: AnyNode): boolean {
  return Boolean(node.typeParameters ?? node.typeArguments);
}
