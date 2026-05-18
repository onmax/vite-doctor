import { AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/html-button-has-type";

export const htmlButtonHasType = createRule({
  meta: {
    id: RULE_ID,
    title: "Require explicit button type",
    description: "Require native buttons to declare type so form behavior is explicit.",
    why: "A native button defaults to submit inside forms, which can trigger accidental form submissions.",
    recommendedReplacement: 'Add type="button", type="submit", or type="reset" to native buttons.',
    examples: [
      {
        title: "Use explicit button type",
        language: "vue",
        invalid: '<template>\n  <button @click="save">Save</button>\n</template>',
        valid: '<template>\n  <button type="button" @click="save">Save</button>\n</template>',
      },
    ],
    category: "template",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || node.rawName !== "button") return;
        if (hasAttributeOrBinding(node, "type")) return;

        const insertAt = node.startTag?.range?.[0] + "<button".length;
        ctx.report(
          diagnostics.VUE0022.report({
            why: 'Native buttons should declare type="button", type="submit", or type="reset".',
            fix: 'Add type="button" unless this button intentionally submits a form.',
          }),
          {
            ruleId: RULE_ID,
            severity: "warn",
            category: "template",
            file: ctx.file.path,
            range: ctx.range(node.startTag ?? node),
            fix:
              typeof insertAt === "number"
                ? {
                    kind: "suggestion",
                    edits: [{ range: { start: insertAt, end: insertAt }, text: ' type="button"' }],
                  }
                : null,
          },
        );
      },
    };
  },
});

function hasAttributeOrBinding(node: AnyNode, name: string): boolean {
  return (node.startTag?.attributes ?? []).some((attribute: AnyNode) => {
    if (!attribute.directive) return attribute.key?.name === name;
    return attribute.key?.name?.name === "bind" && attribute.key?.argument?.name === name;
  });
}
