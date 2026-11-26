import type { RuleContext } from "../../../core/index.js";
import {
  fileScriptScope,
  perFile,
  type ScopeReference,
  type ScopeVariable,
} from "../../../core/internal/script-scope.js";
import type { AnyNode } from "./shared.js";

export function parentOf(node: AnyNode): AnyNode {
  return node?.__doctorParent ?? node?.parent;
}

export function unwrapExpression(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    (current.type === "ParenthesizedExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "AwaitExpression" ||
      current.type === "ChainExpression")
  )
    current = current.expression ?? current.argument;
  return current;
}

export function isFunctionNode(node: AnyNode): boolean {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

export function nearestFunction(node: AnyNode): AnyNode {
  for (let current = parentOf(node); current; current = parentOf(current))
    if (isFunctionNode(current)) return current;
  return null;
}

export function propertyKey(property: AnyNode): string | null {
  if (property?.type !== "Property") return null;
  if (!property.computed && property.key?.type === "Identifier") return property.key.name;
  return property.key?.type === "Literal" ? String(property.key.value) : null;
}

export function memberName(node: AnyNode): string | null {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed) return node.property?.type === "Identifier" ? node.property.name : null;
  return node.property?.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : null;
}

function offset(node: AnyNode): number | undefined {
  return node?.start ?? node?.range?.[0];
}

function referencesByOffset(ctx: RuleContext): Map<number, ScopeReference> | null {
  return perFile(ctx, "h3:errors-helpers:references", () => {
    const scope = fileScriptScope(ctx);
    if (!scope) return null;
    const result = new Map<number, ScopeReference>();
    for (const [identifier, reference] of scope.references)
      result.set((identifier as AnyNode).range[0], reference);
    return result;
  });
}

/** The variable an identifier of the Rule's AST resolves to in the file's scope analysis. */
export function resolveVariable(ctx: RuleContext, identifier: AnyNode): ScopeVariable | null {
  if (identifier?.type !== "Identifier") return null;
  return referencesByOffset(ctx)?.get(offset(identifier) ?? -1)?.resolved ?? null;
}

/** Whether a variable is never assigned after its declaration. */
export function isNeverReassigned(variable: ScopeVariable): boolean {
  const writes = variable.references.filter((reference) => reference.isWrite());
  const definition = variable.defs[0];
  const initialized = definition?.type === "Variable" && definition.node.init ? 1 : 0;
  return variable.defs.length === 1 && writes.length <= initialized;
}

/**
 * The value of a string or number literal, a template literal without expressions, or an
 * identifier bound by `const` to one of these in the same file.
 */
export function staticValue(
  ctx: RuleContext,
  node: AnyNode,
): string | number | boolean | undefined {
  const expression = unwrapExpression(node);
  const literal = literalValue(expression);
  if (literal !== undefined || expression?.type !== "Identifier") return literal;
  const variable = resolveVariable(ctx, expression);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type !== "Variable" || definition.parent?.kind !== "const") return undefined;
  if (definition.node.id?.type !== "Identifier") return undefined;
  return literalValue(unwrapExpression(definition.node.init));
}

function literalValue(node: AnyNode): string | number | boolean | undefined {
  if (
    node?.type === "Literal" &&
    (typeof node.value === "string" ||
      typeof node.value === "number" ||
      typeof node.value === "boolean")
  )
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}
