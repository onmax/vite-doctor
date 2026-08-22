import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, report, unwrapExpression, type AnyNode } from "./shared.js";

const ruleId = "typescript/style/no-conditional-empty-object-spread";

export const noConditionalEmptyObjectSpread = createRule({
  meta: {
    id: "typescript/style/no-conditional-empty-object-spread",
    title: "Make conditional property omission explicit",
    description: "Reject conditional object spreads that use an empty object to omit properties.",
    why: "The empty-object branch hides whether a property is absent or merely undefined and makes the resulting object contract harder to inspect.",
    recommendedReplacement:
      "Build the object first, then add the optional property in a separate conditional statement.",
    examples: [
      {
        title: "Add optional properties explicitly",
        language: "ts",
        invalid: "const options = { ...(timeout ? { timeout } : {}) }",
        valid: "const options: Options = {}\nif (timeout !== undefined) options.timeout = timeout",
      },
    ],
    category: "style",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://github.com/dmmulroy/anti-slop#no-conditional-empty-object-spread",
    requires: { script: true },
    aiGeneratedCodeRisk: "medium",
  },
  create(ctx) {
    if (!isTypeScriptSource(ctx)) return {};
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "SpreadElement") return;
        const conditional = unwrapConditional(node.argument);
        if (
          conditional?.type !== "ConditionalExpression" ||
          (!isEmptyObject(conditional.consequent) && !isEmptyObject(conditional.alternate))
        ) {
          return;
        }
        report(
          ctx,
          node,
          ruleId,
          "This conditional spread hides property omission behind an empty object.",
          "Build the object first and add the property only when the condition holds.",
        );
      },
    };
  },
});

function unwrapConditional(node: AnyNode): AnyNode {
  let current = node;
  while (current?.type === "ParenthesizedExpression") current = current.expression;
  return current;
}

function isEmptyObject(node: AnyNode): boolean {
  const expression = unwrapExpression(node);
  return expression?.type === "ObjectExpression" && !expression.properties?.length;
}
