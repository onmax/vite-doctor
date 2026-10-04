import { type AnyNode, createRule, isNitroServerFile, report } from "./shared.js";
import { isNitroRouteFile, singleMethodCheck } from "./request-helpers.js";

export const preferAssertMethod = createRule({
  meta: {
    id: "nitro/request/prefer-assert-method",
    title: "Use assertMethod for single-method handlers",
    description:
      "Single-method Nitro handlers should use the H3 method assertion helper instead of ad hoc method checks.",
    recommendedReplacement:
      'Use assertMethod(event, "POST") for handlers that accept one HTTP method.',
    category: "request",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/utils/request#assertmethodevent-expected-allowhead",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!isNitroServerFile(ctx)) return;
    if (isNitroRouteFile(ctx)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "IfStatement" || !isUnconditionalGuard(node)) return;
        const check = singleMethodCheck(node.test, ctx.file.text, node);
        if (!check?.isNegative || !rejectsRequest(node.consequent)) return;
        const method = check.method;
        report(
          ctx,
          node,
          "nitro/request/prefer-assert-method",
          "info",
          "request",
          `This handler checks for ${method} manually.`,
          `Use assertMethod(event, "${method}") for single-method Nitro handlers.`,
        );
      },
    };
  },
});

function isUnconditionalGuard(node: AnyNode): boolean {
  let current = node;
  while (current.__doctorParent) {
    const parent = current.__doctorParent;
    if (parent.type === "BlockStatement" || parent.type === "Program") {
      for (const statement of parent.body) {
        if (statement === current) break;
        if (
          !["ExpressionStatement", "VariableDeclaration", "EmptyStatement"].includes(statement.type)
        )
          return false;
      }
      if (parent.type === "Program") return true;
      current = parent;
      continue;
    }
    return (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        parent.type,
      ) && parent.body === current
    );
  }
  return false;
}

function rejectsRequest(node: AnyNode): boolean {
  if (node.type === "ThrowStatement") return true;
  if (node.type !== "BlockStatement") return false;
  for (const statement of node.body) {
    if (rejectsRequest(statement)) return true;
    if (!["ExpressionStatement", "VariableDeclaration", "EmptyStatement"].includes(statement.type))
      return false;
  }
  return false;
}
