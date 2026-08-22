import { createRule } from "../../../core/index.js";
import { isConstAssertion, isTypeAssertion, report, type AnyNode } from "./shared.js";

const ruleId = "typescript/strict/require-safety-comment-for-type-assertion";

export const requireSafetyCommentForTypeAssertion = createRule({
  meta: {
    id: "typescript/strict/require-safety-comment-for-type-assertion",
    title: "Explain necessary type assertions",
    description: "Require a nearby SAFETY comment for non-const TypeScript assertions.",
    why: "A necessary assertion depends on an invariant TypeScript cannot express. Recording that invariant lets reviewers verify the claim and detect when later changes invalidate it.",
    recommendedReplacement:
      "Remove the assertion, or add a specific SAFETY comment immediately before the containing statement.",
    examples: [
      {
        title: "State the checked invariant",
        language: "ts",
        invalid: "const userId = value as UserId",
        valid:
          "// SAFETY: parseUserId validated the identifier before branding it.\nconst userId = value as UserId",
      },
    ],
    category: "strict",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://github.com/dmmulroy/anti-slop#require-safety-comment-for-type-assertion",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (
          !isTypeAssertion(node) ||
          isConstAssertion(node) ||
          hasSafetyComment(ctx.file.text, node)
        ) {
          return;
        }
        report(
          ctx,
          node,
          ruleId,
          "This type assertion does not state the invariant that makes it safe.",
          "Remove the assertion or add a specific SAFETY comment immediately before the statement.",
        );
      },
    };
  },
});

function hasSafetyComment(source: string, node: AnyNode): boolean {
  const start = node.start ?? node.range?.[0];
  if (typeof start !== "number") return false;
  const before = source.slice(0, start);
  const lines = before.split(/\r?\n/);
  return /\bSAFETY\s*:/.test(lines.slice(-2).join("\n"));
}
