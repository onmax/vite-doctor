import type { ScriptScope } from "../../../core/internal/script-scope.js";
import { memberPath, propertyName, staticString, type AnyNode } from "./shared.js";

export const VITE_MODULES = new Set(["vite", "vite-plus", "vitest/config"]);

export function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
      "ChainExpression",
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}

export function importBinding(scope: ScriptScope, node: AnyNode) {
  const definition = scope.references.get(node)?.resolved?.defs[0] as AnyNode;
  if (definition?.type !== "ImportBinding") return;
  const specifier = definition.node;
  const declaration = definition.parent;
  return {
    type: specifier.type as string,
    source: String(declaration.source.value),
    imported: propertyName(specifier.imported),
    typeOnly: declaration.importKind === "type" || specifier.importKind === "type",
  };
}

export function resolveConst(
  scope: ScriptScope,
  input: AnyNode,
  allowAdditionalReads = false,
): AnyNode {
  const seen = new Set<AnyNode>();
  let node = unwrap(input);
  while (node?.type === "Identifier") {
    if (seen.has(node)) return null;
    seen.add(node);
    const variable = scope.references.get(node)?.resolved;
    const definition = variable?.defs.length === 1 ? (variable.defs[0] as AnyNode) : undefined;
    if (
      definition?.type !== "Variable" ||
      definition.parent?.kind !== "const" ||
      definition.node.id.type !== "Identifier" ||
      variable!.references.some(
        (reference) =>
          !reference.init &&
          reference.identifier !== node &&
          (!allowAdditionalReads || reference.isWrite()),
      )
    )
      break;
    node = unwrap(definition.node.init);
  }
  return node;
}

export function propertyKey(property: AnyNode): string | null {
  return property?.type === "Property"
    ? property.computed
      ? staticString(property.key)
      : propertyName(property.key)
    : null;
}

export function objectProperties(scope: ScriptScope, input: AnyNode): Map<string, AnyNode> | null {
  const node = resolveConst(scope, input);
  if (node?.type !== "ObjectExpression") return null;
  const properties = new Map<string, AnyNode>();
  for (const property of node.properties) {
    const key = propertyKey(property);
    if (key === null || key === "__proto__" || property.kind !== "init") return null;
    properties.set(key, property.value);
  }
  return properties;
}

export function simpleReturn(body: AnyNode): AnyNode {
  if (body?.type !== "BlockStatement") return body;
  const last = body.body.at(-1);
  if (
    last?.type === "ReturnStatement" &&
    body.body.slice(0, -1).every((statement: AnyNode) => statement.type === "VariableDeclaration")
  )
    return last.argument;
}

export function staticConfig(scope: ScriptScope): Map<string, AnyNode> | null {
  let exported: AnyNode;
  for (const statement of scope.ast.body) {
    if (statement.type === "ExportDefaultDeclaration") exported = statement.declaration;
    else if (statement.type === "TSExportAssignment") exported = statement.expression;
    else if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AssignmentExpression" &&
      statement.expression.operator === "=" &&
      memberPath(statement.expression.left) === "module.exports"
    ) {
      if (exported) return null;
      exported = statement.expression.right;
    } else if (statement.type === "ExportNamedDeclaration" && !statement.source) {
      const specifier = statement.specifiers.find(
        (item: AnyNode) => propertyName(item.exported) === "default",
      );
      if (specifier) exported = specifier.local;
    } else if (
      ![
        "ImportDeclaration",
        "VariableDeclaration",
        "FunctionDeclaration",
        "TSTypeAliasDeclaration",
        "TSInterfaceDeclaration",
        "EmptyStatement",
      ].includes(statement.type)
    )
      return null;
  }
  let node = resolveConst(scope, exported);
  if (node?.type === "CallExpression") {
    const callee = unwrap(node.callee);
    const binding = importBinding(
      scope,
      callee.type === "MemberExpression" ? callee.object : callee,
    );
    if (!binding || binding.typeOnly || !VITE_MODULES.has(binding.source)) return null;
    if (
      binding.imported !== "defineConfig" &&
      !(
        binding.type === "ImportNamespaceSpecifier" && memberPath(callee)?.endsWith(".defineConfig")
      )
    )
      return null;
    node = resolveConst(scope, node.arguments[0]);
  }
  if (["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node?.type))
    node = simpleReturn(node.body);
  return objectProperties(scope, node);
}

export function clientDefineObjects(
  scope: ScriptScope,
  config: Map<string, AnyNode>,
): AnyNode[] | null {
  const defines = config.has("define") ? [config.get("define")] : [];
  if (!config.has("environments")) return defines;
  const environments = objectProperties(scope, config.get("environments"));
  if (!environments) return null;
  if (!environments.has("client")) return defines;
  const client = objectProperties(scope, environments.get("client"));
  if (!client) return null;
  if (client.has("define")) defines.push(client.get("define"));
  return defines;
}
