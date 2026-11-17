import { createRule } from "../../../core/index.js";
import { hasSafetyComment } from "./safety-comment.js";
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
    description:
      "Reject nested TypeScript assertions that manufacture type evidence, unless a SAFETY comment states the invariant.",
    why: "Each assertion asks the compiler to trust the author. Chaining assertions can erase the original type before claiming an unrelated result type, so neither the compiler nor a reviewer can verify the conversion.",
    recommendedReplacement:
      "Keep the original precise type, narrow it with a type guard, or parse untrusted input into the target type. When the chain is necessary, state the invariant in a SAFETY comment immediately before the statement.",
    examples: [
      {
        title: "Parse before narrowing",
        language: "ts",
        invalid: "const user = input as object as User",
        valid: "const user = UserSchema.parse(input)",
      },
      {
        title: "Document a necessary chain",
        language: "ts",
        invalid: "const driver = db as unknown as SqlDriver",
        valid:
          "// SAFETY: every supported Drizzle SQLite database has the run and all methods of SqlDriver.\nconst driver = db as unknown as SqlDriver",
      },
    ],
    category: "evidence",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/dmmulroy/anti-slop#no-chained-type-assertions",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    const visit = (node: AnyNode) => {
      if (!isOutermostTypeAssertion(node)) return;
      let current = node;
      let count = 0;
      let hasNonConst = false;
      while (isTypeAssertion(current)) {
        count += 1;
        hasNonConst ||= !isConstAssertion(current);
        current = unwrapParentheses(current.expression);
      }
      if (count < 2 || !hasNonConst || hasSafetyComment(ctx, node)) return;
      report(
        ctx,
        node,
        ruleId,
        "This assertion chain skips the compiler's compatibility check, so nothing verifies that the value matches the final type.",
        "Keep the original type, narrow it with a guard, parse the value at its boundary, or state the invariant in a SAFETY comment before the statement.",
      );
    };
    return { TSAsExpression: visit, TSTypeAssertion: visit };
  },
});
