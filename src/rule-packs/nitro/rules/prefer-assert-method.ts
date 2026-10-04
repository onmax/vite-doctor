import { type AnyNode, createRule, isNitroServerFile, report, walkScriptLocal } from "./shared.js";
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
        if (
          !check?.isNegative ||
          (usesGetMethod(node.test) && shadowsGetMethod(node)) ||
          !rejectsRequest(node.consequent)
        )
          return;
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
          ![
            "ExpressionStatement",
            "VariableDeclaration",
            "FunctionDeclaration",
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

function usesGetMethod(node: AnyNode): boolean {
  let found = false;
  walkScriptLocal(node, (child) => {
    if (child.type === "CallExpression" && child.callee?.type === "Identifier")
      found ||= child.callee.name === "getMethod";
  });
  return found;
}

function shadowsGetMethod(node: AnyNode): boolean {
  let scope = node;
  while (scope.__doctorParent) {
    scope = scope.__doctorParent;
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "Program"].includes(
        scope.type,
      )
    )
      break;
  }
  const params = scope.params ?? [];
  if (params.some((param: AnyNode) => patternContainsName(param, "getMethod"))) return true;
  const body = scope.type === "Program" ? scope : scope.body;
  return (body?.body ?? []).some((statement: AnyNode) =>
    declarationContainsName(statement, "getMethod"),
  );
}

function declarationContainsName(node: AnyNode, name: string): boolean {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration")
    return node.id?.name === name;
  if (node.type === "VariableDeclaration")
    return node.declarations?.some((declaration: AnyNode) =>
      patternContainsName(declaration.id, name),
    );
  if (node.type === "ImportDeclaration")
    return node.specifiers?.some((specifier: AnyNode) => specifier.local?.name === name);
  return false;
}

function patternContainsName(node: AnyNode, name: string): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "RestElement" || node.type === "AssignmentPattern")
    return patternContainsName(node.argument ?? node.left, name);
  if (node.type === "ArrayPattern")
    return node.elements?.some((element: AnyNode) => patternContainsName(element, name));
  if (node.type === "ObjectPattern")
    return node.properties?.some((property: AnyNode) => patternContainsName(property.value, name));
  return false;
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
