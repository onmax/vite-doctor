import type { RuleContext } from "../../../core/index.js";
import { fileTextScope, type ScriptScope } from "../../../core/internal/script-scope.js";
import { type AnyNode, createRule, report } from "./shared.js";
import { hasCustomScanIgnore, nitroScannedFile } from "./server-layout.js";

const RULE_ID = "nitro/middleware/no-implicit-response";
const MIDDLEWARE_DIRS = new Set(["middleware"]);
const HANDLER_FACTORIES = new Set([
  "defineEventHandler",
  "eventHandler",
  "defineHandler",
  "defineMiddleware",
]);
const HANDLER_SOURCES = new Set(["h3", "nitro", "nitro/h3", "#imports"]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);

export const noImplicitMiddlewareResponse = createRule({
  meta: {
    id: RULE_ID,
    title: "Don't return an assigned value from server middleware",
    category: "correctness",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/routing#middleware",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!nitroScannedFile(ctx, ctx.file.path, MIDDLEWARE_DIRS) || hasCustomScanIgnore(ctx)) return;
    return {
      Program() {
        const scope = fileTextScope(ctx);
        if (!scope) return;
        const handler = middlewareHandler(scope);
        if (!handler) return;
        for (const node of implicitResponses(scope, handler)) reportImplicitResponse(ctx, node);
      },
    };
  },
});

function reportImplicitResponse(ctx: RuleContext, node: AnyNode) {
  report(
    ctx,
    node,
    RULE_ID,
    "error",
    "correctness",
    "This middleware returns the result of an assignment. Nitro treats any value a middleware returns, other than undefined, as the response: it sends that value and skips the route handler, so every request this middleware sees ends here whenever the assigned value is defined.",
    node.type === "ReturnStatement"
      ? "Evaluate the returned expression, then use a bare `return` on the same branch, for example `if (!user) { event.context.locale = 'en'; return }`. This preserves the early exit without sending a response."
      : "Wrap the body in braces so the middleware returns nothing, for example `(event) => { event.context.user = user }`. Return a value from middleware only to end the request on purpose.",
  );
}

/** The function the middleware file's default export registers. */
function middlewareHandler(scope: ScriptScope): AnyNode {
  const declaration = scope.ast.body?.find(
    (statement: AnyNode) => statement.type === "ExportDefaultDeclaration",
  )?.declaration;
  const call = unwrap(declaration);
  if (FUNCTION_TYPES.has(call?.type)) return call;
  if (call?.type !== "CallExpression" || call.callee?.type !== "Identifier") return undefined;
  if (!HANDLER_FACTORIES.has(call.callee.name) || !isHandlerFactory(scope, call.callee))
    return undefined;
  const input = unwrap(call.arguments?.[0]);
  if (FUNCTION_TYPES.has(input?.type)) return input;
  if (input?.type !== "ObjectExpression") return undefined;
  for (const property of [...input.properties].reverse()) {
    if (property.type !== "Property" || property.computed) return undefined;
    if (propertyName(property.key) !== "handler") continue;
    const handler = unwrap(property.value);
    return property.kind === "init" && FUNCTION_TYPES.has(handler?.type) ? handler : undefined;
  }
  return undefined;
}

function isHandlerFactory(scope: ScriptScope, callee: AnyNode) {
  const variable = scope.references.get(callee)?.resolved;
  if (!variable) return true;
  const def = variable.defs.length === 1 ? (variable.defs[0] as AnyNode) : undefined;
  if (
    def?.type !== "ImportBinding" ||
    def.parent?.type !== "ImportDeclaration" ||
    def.node.type !== "ImportSpecifier"
  )
    return false;
  const imported = def.node.imported?.name ?? def.node.imported?.value;
  return imported === callee.name && HANDLER_SOURCES.has(String(def.parent.source.value));
}

function implicitResponses(scope: ScriptScope, handler: AnyNode): AnyNode[] {
  if (handler.generator) return [];
  if (handler.expression || handler.body?.type !== "BlockStatement")
    return returnsAssignedValue(scope, handler.body) ? [handler.body] : [];
  const found: AnyNode[] = [];
  visitOwnStatements(scope, handler.body, (node) => {
    if (node.type === "ReturnStatement" && returnsAssignedValue(scope, node.argument))
      found.push(node);
  });
  return found;
}

function returnsAssignedValue(scope: ScriptScope, node: AnyNode): boolean {
  node = unwrap(node);
  if (node?.type === "SequenceExpression")
    return returnsAssignedValue(scope, node.expressions.at(-1));
  if (node?.type === "AssignmentExpression")
    return node.operator !== "=" || !isUndefined(scope, node.right);
  return isObjectAssign(scope, node);
}

function isObjectAssign(scope: ScriptScope, node: AnyNode) {
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "Object" &&
    isGlobal(scope, callee.object) &&
    callee.property?.name === "assign"
  );
}

function isUndefined(scope: ScriptScope, node: AnyNode) {
  node = unwrap(node);
  if (node?.type === "UnaryExpression" && node.operator === "void") return true;
  return node?.type === "Identifier" && node.name === "undefined" && isGlobal(scope, node);
}

/** Unbound, or bound only to a TypeScript lib global such as `Object` or `undefined`. */
function isGlobal(scope: ScriptScope, identifier: AnyNode) {
  return !scope.references.get(identifier)?.resolved?.defs.length;
}

/** Visits the handler's statements without entering nested functions or classes. */
function visitOwnStatements(scope: ScriptScope, node: AnyNode, callback: (node: AnyNode) => void) {
  if (!node?.type) return;
  callback(node);
  for (const key of scope.visitorKeys[node.type] ?? []) {
    const child = node[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (!item?.type || FUNCTION_TYPES.has(item.type) || item.type === "FunctionDeclaration")
        continue;
      if (item.type === "ClassDeclaration" || item.type === "ClassExpression") continue;
      visitOwnStatements(scope, item, callback);
    }
  }
}

function propertyName(node: AnyNode): string | undefined {
  if (node?.type === "Identifier") return node.name;
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function unwrap(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}
