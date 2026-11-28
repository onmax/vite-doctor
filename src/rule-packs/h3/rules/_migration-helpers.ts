import type { RuleContext } from "../../../core/index.js";
import {
  fileScriptScope,
  perFile,
  type ScopeReference,
} from "../../../core/internal/script-scope.js";
import { type AnyNode, h3ExportName, isH3AppReceiver, isH3HandlerFile } from "./shared.js";

const h3SourcePattern = /["'](?:h3|nitro\/h3|h3\/[\w-]+)["']/;

/**
 * Whether the file can name an h3 app: an h3 handler file, or one that imports h3 only for types,
 * such as a module exporting a function that takes an `app: H3` parameter.
 */
export function mayReferenceH3App(ctx: RuleContext): boolean {
  return isH3HandlerFile(ctx) || h3SourcePattern.test(ctx.file.text);
}

/** A property's static key: an identifier, or a string or number literal. */
export function propertyKey(property: AnyNode): string | null {
  if (property?.type !== "Property") return null;
  if (!property.computed && property.key?.type === "Identifier") return property.key.name;
  return property.key?.type === "Literal" ? String(property.key.value) : null;
}

/** A member expression's static property name, written as `a.b`, `a["b"]`, or ``a[`b`]``. */
export function memberName(node: AnyNode): string | null {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed) return node.property?.type === "Identifier" ? node.property.name : null;
  return staticString(node.property);
}

/** The value of a string literal or of a template literal without expressions. */
export function staticString(node: AnyNode): string | null {
  const expression = unwrap(node);
  if (expression?.type === "Literal" && typeof expression.value === "string")
    return expression.value;
  if (expression?.type === "TemplateLiteral" && expression.expressions.length === 0)
    return expression.quasis[0]?.value.cooked ?? null;
  return null;
}

/** The method `node` calls when it calls a method on an h3 app or router. */
export function h3AppMethod(ctx: RuleContext, node: AnyNode): string | null {
  if (node?.type !== "CallExpression") return null;
  const callee = unwrap(node.callee);
  const method = memberName(callee);
  return method && isH3AppReceiver(ctx, callee.object, true) ? method : null;
}

/**
 * What `node` evaluates to: itself, or for an identifier, the function it declares or the
 * initializer of a binding that is never reassigned. Null when the identifier does not resolve.
 */
export function constantValue(ctx: RuleContext, node: AnyNode): AnyNode {
  const expression = unwrap(node);
  if (expression?.type !== "Identifier") return expression;
  const variable = referencesByOffset(ctx)?.get(
    expression.start ?? expression.range?.[0] ?? -1,
  )?.resolved;
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type === "FunctionName") return definition.node;
  if (definition?.type !== "Variable" || definition.node.id?.type !== "Identifier") return null;
  const writes = variable!.references.filter((reference) => reference.isWrite());
  return writes.length <= 1 ? unwrap(definition.node.init) : null;
}

const middlewareFactories = new Set([
  "basicAuth",
  "bodyLimit",
  "defineEventHandler",
  "defineHandler",
  "defineLazyEventHandler",
  "defineMiddleware",
  "defineNodeHandler",
  "defineNodeListener",
  "defineNodeMiddleware",
  "eventHandler",
  "fromNodeHandler",
  "fromNodeMiddleware",
  "fromWebHandler",
  "lazyEventHandler",
  "onError",
  "onRequest",
  "onResponse",
  "toMiddleware",
]);

/**
 * Whether `node` is known to be a plain middleware or handler function rather than an H3 app:
 * a function, a binding to one, or a call of an h3 helper that returns a handler. Anything Doctor
 * cannot resolve, such as an import from another module, is not.
 */
export function isKnownMiddleware(ctx: RuleContext, node: AnyNode): boolean {
  const value = constantValue(ctx, node);
  if (!value || isH3AppReceiver(ctx, node)) return false;
  if (
    value.type === "ArrowFunctionExpression" ||
    value.type === "FunctionExpression" ||
    value.type === "FunctionDeclaration"
  )
    return true;
  return (
    value.type === "CallExpression" &&
    middlewareFactories.has(h3ExportName(ctx, value.callee) ?? "")
  );
}

function referencesByOffset(ctx: RuleContext): Map<number, ScopeReference> | null {
  return perFile(ctx, "h3:migration-references", () => {
    const scope = fileScriptScope(ctx);
    if (!scope) return null;
    try {
      const result = new Map<number, ScopeReference>();
      for (const [identifier, reference] of scope.references)
        result.set((identifier as AnyNode).range[0], reference);
      return result;
    } catch {
      return null;
    }
  });
}

export function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    (current.type === "ParenthesizedExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "ChainExpression")
  )
    current = current.expression;
  return current;
}
