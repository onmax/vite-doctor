import { parseForESLint } from "@typescript-eslint/parser";
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
    const methodReferences = getMethodReferences(ctx.file.text, ctx.file.relativePath);
    return {
      IfStatement(node: AnyNode) {
        if (!isUnconditionalGuard(node)) return;
        const check = singleMethodCheck(node.test, ctx.file.text, node);
        if (
          !check?.isNegative ||
          usesLocalGetMethod(node.test, methodReferences) ||
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

function usesLocalGetMethod(node: AnyNode, references: Set<number> | undefined): boolean {
  let found = false;
  walkScriptLocal(node, (child) => {
    if (
      child.type === "CallExpression" &&
      child.callee?.type === "Identifier" &&
      child.callee.name === "getMethod"
    )
      found ||= !references?.has(child.callee.start);
  });
  return found;
}

function getMethodReferences(source: string, path: string): Set<number> | undefined {
  try {
    const { scopeManager } = parseForESLint(source, {
      range: true,
      sourceType: "module",
      ecmaFeatures: { jsx: /\.[jt]sx$/.test(path) },
    });
    const result = new Set<number>();
    for (const scope of scopeManager.scopes) {
      for (const reference of scope.references) {
        if (reference.identifier.name !== "getMethod") continue;
        const variable = reference.resolved;
        if (
          !variable ||
          variable.defs.every(
            (definition) =>
              definition.type === "ImportBinding" &&
              definition.parent.type === "ImportDeclaration" &&
              definition.parent.source.value === "h3" &&
              definition.parent.importKind !== "type" &&
              definition.node.type === "ImportSpecifier" &&
              definition.node.importKind !== "type" &&
              (definition.node.imported.type === "Identifier"
                ? definition.node.imported.name
                : definition.node.imported.value) === "getMethod",
          )
        )
          result.add(reference.identifier.range[0]);
      }
    }
    return result;
  } catch {
    return undefined;
  }
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
