import { AnyNode, createRule } from "./shared.js";
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
      TemplateNode(node: AnyNode) {
        if (!isNativeElement(node)) return;

        for (const attribute of node.startTag?.attributes ?? []) {
          if (attribute.type !== "VAttribute" || !attribute.directive) continue;
          if (attribute.key?.name?.name !== "bind") continue;

          const argumentName = attribute.key?.argument?.name;
          if (!argumentName || !BOOLEAN_ATTRIBUTES.has(argumentName)) continue;
          if (
            attribute.value?.expression?.type !== "Literal" ||
            attribute.value.expression.value !== true
          )
            continue;

          ctx.report(
            diagnostics.VUE0024.report({
              why: `Use the native ${argumentName} boolean attribute instead of binding true.`,
              fix: `Use ${argumentName}.`,
            }),
            {
              ruleId: RULE_ID,
              severity: "info",
              category: "template",
              file: ctx.file.path,
              range: ctx.range(attribute),
              fix: attribute.range
                ? {
                    kind: "suggestion",
                    edits: [
                      {
                        range: { start: attribute.range[0], end: attribute.range[1] },
                        text: argumentName,
                      },
                    ],
                  }
                : null,
            },
          );
        }
      },
    };
  },
});

function isNativeElement(node: AnyNode): boolean {
  return node?.type === "VElement" && /^[a-z][a-z0-9-]*$/.test(node.rawName ?? "");
}
