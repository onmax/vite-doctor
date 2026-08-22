import { createRule } from "../../../core/index.js";
import {
  isConstAssertion,
  isOutermostTypeAssertion,
  isTypeAssertion,
  report,
  unwrapParentheses,
  type AnyNode,
} from "./shared.js";

const ruleId = "typescript/evidence/no-chained-type-assertions";

export const noChainedTypeAssertions = createRule({
  meta: {
    id: "typescript/evidence/no-chained-type-assertions",
    title: "Do not chain type assertions",
    description: "Reject nested TypeScript assertions that manufacture type evidence.",
    why: "Each assertion asks the compiler to trust the author. Chaining assertions can erase the original type before claiming an unrelated result type, so neither the compiler nor a reviewer can verify the conversion.",
    recommendedReplacement:
      "Keep the original precise type, narrow it with a type guard, or parse untrusted input into the target type.",
    examples: [
      {
        title: "Parse before narrowing",
        language: "ts",
        invalid: "const user = input as object as User",
        valid: "const user = UserSchema.parse(input)",
      },
    ],
    category: "evidence",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://github.com/dmmulroy/anti-slop#no-chained-type-assertions",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!isTypeAssertion(node) || !isOutermostTypeAssertion(node)) return;
        let current = node;
        let count = 0;
        let hasNonConst = false;
        while (isTypeAssertion(current)) {
          count += 1;
          hasNonConst ||= !isConstAssertion(current);
          current = unwrapParentheses(current.expression);
        }
        if (count < 2 || !hasNonConst) return;
        report(
          ctx,
          node,
          ruleId,
          "This assertion chain discards the value's known type before claiming a new one.",
          "Keep the original type, narrow it with a guard, or parse the value at its boundary.",
        );
      },
    };
  },
});
