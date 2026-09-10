import { createRule } from "../../../core/index.js";
import { isConstAssertion, isTypeAssertion, parentOf, report, type AnyNode } from "./shared.js";

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
          hasSafetyComment(ctx.file.text, (ctx.file.scriptAst?.comments as AnyNode[]) ?? [], node)
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

const commentOwners = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function hasSafetyComment(source: string, comments: AnyNode[], node: AnyNode): boolean {
  let current = node;
  while (current && current.type !== "Program") {
    let before = current.start;
    let low = 0;
    let high = comments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (comments[middle]!.end <= before) low = middle + 1;
      else high = middle;
    }
    let value = "";
    for (let index = low - 1; index >= 0; index--) {
      const comment = comments[index]!;
      const gap = source.slice(comment.end, before);
      if (gap.trim() || (gap.match(/\r\n|\r|\n/g)?.length ?? 0) > 1) break;
      value = `${comment.value.replace(/^[ \t]*\*[ \t]?/gm, "")}\n${value}`;
      if (/(?:^|[^\p{L}\p{N}_])SAFETY\s*:\s*\S/u.test(value)) return true;
      before = comment.start;
    }
    const parent = parentOf(current);
    if (commentOwners.has(current.type)) {
      const exported = parent?.type === "ExportNamedDeclaration" && parent.declaration === current;
      const loopInitializer =
        current.type === "VariableDeclaration" &&
        ((parent?.type === "ForStatement" && parent.init === current) ||
          ((parent?.type === "ForOfStatement" || parent?.type === "ForInStatement") &&
            parent.left === current));
      if (!exported && !loopInitializer) return false;
    }
    current = parent;
  }
  return false;
}
