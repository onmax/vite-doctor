import { AnyNode, createRule, report } from "./shared.js";

export const requireVForKey = createRule({
  meta: {
    id: "vue/template/require-v-for-key",
    title: "Require stable keys on v-for",
    category: "template",
    severity: "error",
    fixable: "suggestion",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement") return;
        if (
          ctx.helpers.hasVueDirective(node, "for") &&
          !ctx.helpers.hasVueDirective(node, "bind", "key") &&
          !ctx.helpers.hasVueAttribute(node, "key")
        ) {
          report(
            ctx,
            node,
            "vue/template/require-v-for-key",
            "error",
            "template",
            "v-for lists need a stable key so Vue can preserve component and DOM identity during updates.",
            "Add :key using a stable item id.",
          );
        }
      },
    };
  },
});
