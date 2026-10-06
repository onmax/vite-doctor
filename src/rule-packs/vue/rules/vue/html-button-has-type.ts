import { startTagEnd } from "../../../../core/rule-authoring.js";
import { createRule } from "./shared.js";
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
    docsUrl: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#type",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      template: {
        element(node) {
          if (node.tag !== "button") return;
          if (
            ctx.helpers.hasVueAttribute(node, "type") ||
            ctx.helpers.hasVueDirective(node, "bind", "type")
          )
            return;

          const start = node.loc.start.offset;
          const insertAt = start + "<button".length;
          ctx.report(
            diagnostics.VUE0022({
              why: 'Native buttons should declare type="button", type="submit", or type="reset".',
              fix: 'Add type="button" unless this button intentionally submits a form.',
            }),
            {
              ruleId: RULE_ID,
              severity: "warn",
              category: "template",
              file: ctx.file.path,
              range: ctx.range(start, startTagEnd(node, ctx.file.text)),
              fix: {
                kind: "suggestion",
                edits: [{ range: { start: insertAt, end: insertAt }, text: ' type="button"' }],
              },
            },
          );
        },
      },
    };
  },
});
