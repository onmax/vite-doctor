import { AnyNode, createRule, report } from "./shared.js";

export const preferUseTemplateRef = createRule({
  meta: {
    id: "vue/template/prefer-use-template-ref",
    title: "Prefer useTemplateRef for template refs",
    category: "template",
    severity: "info",
    fixable: "suggestion",
    requires: { sfc: true, template: true, script: true, vue: true },
  },
  create(ctx) {
    const refs = new Set<string>();
    return {
      SFC(sfc) {
        for (const match of sfc.source.matchAll(/\bref=["']([^"']+)["']/g)) {
          refs.add(match[1]);
        }
      },
      TemplateNode(node: AnyNode) {
        if (node.type === "VElement") {
          const ref = ctx.helpers.getStaticVueAttributeValue(node, "ref");
          if (ref) refs.add(ref);
        }
      },
      ScriptNode(node: AnyNode) {
        if (
          node.type === "VariableDeclarator" &&
          node.id?.type === "Identifier" &&
          refs.has(node.id.name) &&
          ctx.helpers.isCall(node.init, "ref")
        ) {
          report(
            ctx,
            node,
            "vue/template/prefer-use-template-ref",
            "info",
            "template",
            "Vue 3.5 supports useTemplateRef() for template refs, which keeps the ref name tied to the template.",
            `Use useTemplateRef('${node.id.name}').`,
          );
        }
      },
    };
  },
});
