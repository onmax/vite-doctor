import { AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

interface Options {
  allowWithDefaults?: boolean;
}

export const preferPropsDestructureDefaults = createRule({
  meta: {
    id: "vue/style/prefer-props-destructure-defaults",
    title: "Prefer props destructure defaults",
    category: "style",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/api/sfc-script-setup.html#reactive-props-destructure",
    requires: { sfc: true, script: true, vue: true },
    frameworkVersions: { vue: ">=3.5" },
  },
  create(ctx) {
    const options = (ctx.options ?? {}) as Options;
    if (options.allowWithDefaults || !ctx.file.text.includes("<script setup")) return;

    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "withDefaults")) return;
        if (!ctx.helpers.isCall(node.arguments?.[0], "defineProps")) return;
        ctx.report(
          diagnostics.VUE0015({
            why: "Vue 3.5 supports reactive props destructure with native default values.",
            fix: "Use const { prop = defaultValue } = defineProps<Props>().",
          }),
          {
            ruleId: "vue/style/prefer-props-destructure-defaults",
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
