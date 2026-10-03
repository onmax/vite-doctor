import { AnyNode, createRule, nearestFunctionOrProgram } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const returnNavigateToInMiddleware = createRule({
  meta: {
    id: "nuxt/routing/return-navigateto-in-middleware",
    title: "Return navigateTo in route middleware",
    category: "routing",
    severity: "error",
    fixable: "safe",
    docsUrl: "https://nuxt.com/docs/4.x/api/utils/navigate-to#within-route-middleware",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !ctx.file.relativePath.includes("/middleware/") &&
      !ctx.file.relativePath.startsWith("middleware/") &&
      !ctx.file.relativePath.startsWith("app/middleware/")
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "navigateTo")) return;
        const expression = navigationExpression(node);
        if (isReturned(expression)) return;
        const statement = expression.__doctorParent;
        const scope = nearestFunctionOrProgram(expression);
        const fixStart = expression.start;
        ctx.report(
          diagnostics.NUXT0052({
            why: "Route middleware must return navigateTo() so Nuxt can stop or redirect the navigation.",
            fix: "Return the navigateTo() result from the route middleware.",
          }),
          {
            ruleId: "nuxt/routing/return-navigateto-in-middleware",
            severity: "error",
            category: "routing",
            file: ctx.file.path,
            range: ctx.range(node),
            fix:
              statement?.type === "ExpressionStatement" && scope && scope.type !== "Program"
                ? {
                    kind: "safe",
                    edits: [{ range: { start: fixStart, end: fixStart }, text: "return " }],
                  }
                : null,
          },
        );
      },
    };
  },
});

function navigationExpression(node: AnyNode): AnyNode {
  let current = node;
  while (
    [
      "AwaitExpression",
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
    ].includes(current.__doctorParent?.type)
  )
    current = current.__doctorParent;
  return current;
}

function isReturned(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  if (!parent) return false;
  if (parent.type === "ReturnStatement" && parent.argument === node) return true;
  if (parent.type === "ArrowFunctionExpression" && parent.body === node) return true;
  if (
    parent.type === "ConditionalExpression" &&
    (parent.consequent === node || parent.alternate === node)
  )
    return isReturned(navigationExpression(parent));
  if (parent.type === "LogicalExpression" && (parent.left === node || parent.right === node))
    return isReturned(navigationExpression(parent));
  return false;
}
