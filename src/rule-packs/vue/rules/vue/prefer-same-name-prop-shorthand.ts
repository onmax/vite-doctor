import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/prefer-same-name-prop-shorthand";

export const preferSameNamePropShorthand = createRule({
  meta: {
    id: RULE_ID,
    title: "Prefer same-name prop shorthand",
    description:
      "Prefer Vue 3.4 same-name v-bind shorthand when a prop and its bound variable have the same logical name.",
    why: "Repeating the same prop name and variable name in templates adds noise without adding meaning.",
    recommendedReplacement:
      "Use :prop or v-bind:prop only when the bound variable has the same logical name.",
    examples: [
      {
        title: "Use same-name prop shorthand",
        language: "vue",
        invalid: '<template>\n  <MyCmp :my-prop="myProp" />\n</template>',
        valid: "<template>\n  <MyCmp :my-prop />\n</template>",
      },
      {
        title: "Keep explicit bindings when names differ",
        language: "vue",
        invalid: '<template>\n  <MyCmp :my-prop="myProp" />\n</template>',
        valid: '<template>\n  <MyCmp :my-prop="selectedValue" />\n</template>',
      },
    ],
    category: "template",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/template-syntax.html#same-name-shorthand",
    requires: { template: true, vue: true },
    frameworkVersions: { vue: ">=3.4" },
  },
  create(ctx) {
    return {
      template: {
        directive(node) {
          if (node.name !== "bind" || !node.arg?.isStatic || !node.exp) return;
          const argumentName = node.arg.content;

          const expression = ctx.helpers.parseTemplateExpression(node.exp);
          if (expression?.type !== "Identifier") return;
          if (normalizePropName(argumentName) !== expression.name) return;

          const start = node.loc.start.offset;
          const keyEnd = start + (node.rawName ?? "").length;
          const attributeEnd = node.loc.end.offset;
          if (keyEnd <= start || keyEnd >= attributeEnd) return;

          ctx.report(
            diagnostics.VUE0023({
              why: `Use Vue's same-name prop shorthand for ${argumentName}.`,
              fix: `Use ${ctx.file.text.slice(start, keyEnd)}.`,
            }),
            {
              ruleId: RULE_ID,
              severity: "info",
              category: "template",
              file: ctx.file.path,
              range: ctx.range(node),
              fix: {
                kind: "suggestion",
                edits: [{ range: { start: keyEnd, end: attributeEnd }, text: "" }],
              },
            },
          );
        },
      },
    };
  },
});

function normalizePropName(name: string): string {
  return name.replace(/-([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
}
