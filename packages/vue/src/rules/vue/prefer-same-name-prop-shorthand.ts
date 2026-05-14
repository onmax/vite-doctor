import { AnyNode, createRule } from "./shared.js";

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
      TemplateNode(node: AnyNode) {
        if (node.type !== "VAttribute" || !node.directive) return;
        if (directiveName(node) !== "bind") return;

        const argumentName = staticArgumentName(node);
        if (!argumentName) return;

        const expression = node.value?.expression;
        if (expression?.type !== "Identifier" || !expression.end) return;
        if (normalizePropName(argumentName) !== expression.name) return;

        const keyEnd = node.key?.range?.[1];
        const attributeEnd = node.range?.[1];
        if (
          typeof keyEnd !== "number" ||
          typeof attributeEnd !== "number" ||
          keyEnd >= attributeEnd
        )
          return;

        ctx.report({
          ruleId: RULE_ID,
          severity: "info",
          category: "template",
          file: ctx.file.path,
          range: ctx.range(node),
          message: `Use Vue's same-name prop shorthand for ${argumentName}.`,
          suggestion: `Use ${ctx.file.text.slice(node.range[0], keyEnd)}.`,
          fix: {
            kind: "suggestion",
            edits: [{ range: { start: keyEnd, end: attributeEnd }, text: "" }],
          },
        });
      },
    };
  },
});

function directiveName(node: AnyNode): string | null {
  return node.key?.name?.name ?? node.key?.name ?? null;
}

function staticArgumentName(node: AnyNode): string | null {
  const argument = node.key?.argument;
  return argument?.type === "VIdentifier" ? argument.name : null;
}

function normalizePropName(name: string): string {
  return name.replace(/-([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
}
