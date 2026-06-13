import { AnyNode, createRule, report } from "./shared.js";

export const restrictVHtml = createRule({
  meta: {
    id: "vue/security/restrict-v-html",
    title: "Restrict v-html to trusted HTML",
    category: "security",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/best-practices/security.html#html-injection",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type === "VElement" && ctx.helpers.hasVueDirective(node, "html")) {
          report(
            ctx,
            node,
            "vue/security/restrict-v-html",
            "error",
            "security",
            "v-html can execute untrusted markup. Only render sanitized or trusted HTML here.",
            "Remove v-html or sanitize the HTML before rendering it.",
          );
        }
      },
    };
  },
});
