import { AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

interface Options {
  allowRuntimeValidators?: boolean;
}

export const preferTypeProps = createRule({
  meta: {
    id: "vue/style/prefer-type-props",
    title: "Prefer TypeScript props declarations",
    description: "Use type-only defineProps declarations in TypeScript <script setup> components.",
    why: "Runtime prop declarations duplicate information TypeScript can already express, and they make prop contracts harder to reuse across components, composables, and tests.",
    recommendedReplacement:
      "Use defineProps<Props>() or defineProps<{ foo: string }>() instead of runtime props objects when the component already uses TypeScript.",
    examples: [
      {
        title: "Declare props with TypeScript",
        language: "vue",
        invalid: `<script setup lang="ts">
const props = defineProps({
  title: String,
  count: Number,
})
</script>`,
        valid: `<script setup lang="ts">
interface Props {
  title: string
  count?: number
}

const props = defineProps<Props>()
</script>`,
      },
    ],
    category: "style",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/api/sfc-script-setup.html#type-only-props-emit-declarations",
    requires: { sfc: true, script: true, vue: true },
  },
  create(ctx) {
    const options = (ctx.options ?? {}) as Options;
    if (options.allowRuntimeValidators || !isTypeScriptScriptSetup(ctx.file.text)) return;

    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "defineProps")) return;
        if (!node.arguments?.length || hasTypeParameters(node)) return;
        ctx.report(
          diagnostics.VUE0016({
            why: "TypeScript <script setup> components should declare props with a type argument.",
            fix: "Use defineProps<Props>() instead of a runtime props declaration.",
          }),
          {
            ruleId: "vue/style/prefer-type-props",
            severity: ctx.severity,
            category: "style",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
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
