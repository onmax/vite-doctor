import type { RuleContext } from "../../../core/index.js";
import {
  type AnyNode,
  createRule,
  h3ExportName,
  isH3HandlerFile,
  isHandlerFunction,
  isNitroRouteFile,
  isNitroServerFile,
  report,
  walkScriptLocal,
} from "./shared.js";
import { singleMethodCheck } from "./request-helpers.js";

export const preferAssertMethod = createRule({
  meta: {
    id: "h3/request/prefer-assert-method",
    title: "Use assertMethod for single-method handlers",
    description:
      "Single-method H3 handlers should use the H3 method assertion helper instead of ad hoc method checks.",
    recommendedReplacement:
      'Use assertMethod(event, "POST") for handlers that accept one HTTP method.',
    category: "request",
    severity: "info",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/utils/request#assertmethodevent-expected-allowhead",
    requires: { script: true },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    // Nitro route files express the accepted method in their filename instead.
    if (isNitroRouteFile(ctx)) return;
    const autoImports = isNitroServerFile(ctx);
    return {
      IfStatement(node: AnyNode) {
        if (!isUnconditionalGuard(node)) return;
        if (!autoImports && !isHandlerFunction(ctx, enclosingFunction(node))) return;
        const check = singleMethodCheck(node.test, ctx.file.text, node);
        if (
          !check?.isNegative ||
          usesNonH3GetMethod(ctx, node.test) ||
          !rejectsRequest(node.consequent)
        )
          return;
        const method = check.method;
        report(
          ctx,
          node,
          "h3/request/prefer-assert-method",
          "info",
          "request",
          `This handler checks for ${method} manually.`,
          `Use assertMethod(event, "${method}") for single-method handlers.`,
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
          ![
            "ExpressionStatement",
            "VariableDeclaration",
            "FunctionDeclaration",
            "ImportDeclaration",
            "EmptyStatement",
          ].includes(statement.type)
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

function enclosingFunction(node: AnyNode): AnyNode {
  let current = node.__doctorParent;
  while (
    current &&
    !/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(current.type)
  )
    current = current.__doctorParent;
  return current;
}

function usesNonH3GetMethod(ctx: RuleContext, node: AnyNode): boolean {
  let found = false;
  walkScriptLocal(node, (child) => {
    if (
      child.type === "CallExpression" &&
      (child.callee?.type === "Identifier" || child.callee?.type === "MemberExpression") &&
      (child.callee.name ?? child.callee.property?.name) === "getMethod"
    )
      found ||= h3ExportName(ctx, child.callee) !== "getMethod";
  });
  return found;
}

function rejectsRequest(node: AnyNode): boolean {
  if (node.type === "ThrowStatement") return true;
  if (node.type !== "BlockStatement") return false;
  for (const statement of node.body) {
    if (rejectsRequest(statement)) return true;
    if (
      ![
        "ExpressionStatement",
        "VariableDeclaration",
        "FunctionDeclaration",
        "EmptyStatement",
      ].includes(statement.type)
    )
      return false;
  }
  return false;
}
