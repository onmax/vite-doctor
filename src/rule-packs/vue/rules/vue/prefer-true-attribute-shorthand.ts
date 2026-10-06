import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/prefer-true-attribute-shorthand";

const BOOLEAN_ATTRIBUTES = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);

export const preferTrueAttributeShorthand = createRule({
  meta: {
    id: RULE_ID,
    title: "Prefer true attribute shorthand",
    description: "Prefer native boolean attributes over v-bind expressions that only pass true.",
    why: "Native boolean attributes are true by presence, so binding a literal true adds template noise without changing behavior.",
    recommendedReplacement:
      'Use the bare native attribute, such as disabled, instead of :disabled="true".',
    examples: [
      {
        title: "Use native boolean shorthand",
        language: "vue",
        invalid: '<template>\n  <button :disabled="true">Save</button>\n</template>',
        valid: "<template>\n  <button disabled>Save</button>\n</template>",
      },
    ],
    category: "template",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://eslint.vuejs.org/rules/prefer-true-attribute-shorthand.html",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      template: {
        directive(attribute, element) {
          if (!isNativeElement(element.tag)) return;
          if (attribute.name !== "bind" || !attribute.arg?.isStatic || !attribute.exp) return;

          const argumentName = attribute.arg.content;
          if (!BOOLEAN_ATTRIBUTES.has(argumentName)) return;
          const expression = ctx.helpers.parseTemplateExpression(attribute.exp);
          if (expression?.type !== "Literal" || expression.value !== true) return;

          ctx.report(
            diagnostics.VUE0024({
              why: `Use the native ${argumentName} boolean attribute instead of binding true.`,
              fix: `Use ${argumentName}.`,
            }),
            {
              ruleId: RULE_ID,
              severity: "info",
              category: "template",
              file: ctx.file.path,
              range: ctx.range(attribute),
              fix: {
                kind: "suggestion",
                edits: [
                  {
                    range: { start: attribute.loc.start.offset, end: attribute.loc.end.offset },
                    text: argumentName,
                  },
                ],
              },
            },
          );
        },
      },
    };
  },
});

function isNativeElement(tag: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(tag);
}
