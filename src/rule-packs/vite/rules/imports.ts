import { createRule } from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import { memberPath, staticString, type AnyNode } from "./shared.js";

export const requireStaticGlobPattern = createRule({
  meta: {
    id: "vite/imports/require-static-glob-pattern",
    title: "Use literal patterns in import.meta.glob",
    category: "imports",
    severity: "error",
    docsUrl: "https://vite.dev/guide/features#glob-import-caveats",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "CallExpression") return;
        const callee = node.callee;
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed ||
          memberPath(callee) !== "import.meta.glob"
        )
          return;
        const pattern = unwrapTypeExpression(node.arguments[0]);
        if (isLiteralPattern(pattern)) return;
        if (
          pattern?.type === "ArrayExpression" &&
          pattern.elements.every((element: AnyNode) => !element || isLiteralPattern(element))
        )
          return;
        ctx.report(
          diagnostics.VITE0022({
            why: "Vite requires literal string patterns in import.meta.glob; variables and other expressions can fail the transform or leave modules out of the generated map.",
            fix: "Pass a string literal or an array of string literals directly to import.meta.glob. For runtime selection, use a literal glob and select from the returned module map.",
          }),
          {
            ruleId: "vite/imports/require-static-glob-pattern",
            severity: ctx.severity,
            category: "imports",
            file: ctx.file.path,
            range: ctx.range(pattern ?? node),
          },
        );
      },
    };
  },
});

function isLiteralPattern(node: AnyNode): boolean {
  return staticString(unwrapTypeExpression(node)) !== null;
}

function unwrapTypeExpression(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}
