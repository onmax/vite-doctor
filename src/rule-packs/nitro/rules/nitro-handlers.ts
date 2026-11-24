import type { RuleContext } from "../../../core/index.js";
import type { ScriptScope } from "../../../core/internal/script-scope.js";
import { type AnyNode, report } from "./shared.js";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ChainExpression",
]);
const HANDLER_FACTORIES = new Set([
  "defineEventHandler",
  "eventHandler",
  "defineHandler",
  "defineCachedEventHandler",
  "defineCachedHandler",
]);
const HANDLER_MODULES = new Set([
  "h3",
  "nitro/h3",
  "nitro",
  "nitro/cache",
  "nitropack/runtime",
  "#imports",
  "#internal/nitro",
]);

export function unwrapExpression(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

export function isFunction(node: AnyNode) {
  return FUNCTION_TYPES.has(node?.type);
}

/**
 * Whether the identifier names `name`: a global or auto-import of that name, or an import of
 * `name` from one of `modules`. Local bindings and imports from elsewhere are not it.
 */
export function resolvesToImport(
  scope: ScriptScope,
  identifier: AnyNode,
  name: string,
  modules: ReadonlySet<string>,
): boolean {
  if (identifier?.type !== "Identifier") return false;
  const reference = scope.references.get(identifier);
  if (!reference) return false;
  const variable = reference.resolved;
  if (!variable) return identifier.name === name;
  return variable.defs.some((definition: any) => {
    if (
      definition.type !== "ImportBinding" ||
      definition.parent?.type !== "ImportDeclaration" ||
      definition.parent.importKind === "type" ||
      !modules.has(String(definition.parent.source.value))
    )
      return false;
    const binding = definition.node;
    if (binding.type !== "ImportSpecifier" || binding.importKind === "type") return false;
    const imported =
      binding.imported.type === "Identifier"
        ? binding.imported.name
        : String(binding.imported.value);
    return imported === name;
  });
}

/** The variable an identifier reads, or undefined for globals and unresolved names. */
export function resolvedVariable(scope: ScriptScope, identifier: AnyNode) {
  return scope.references.get(identifier)?.resolved ?? undefined;
}

/**
 * Functions the file registers as Nitro event handlers: the first argument of
 * defineEventHandler() and its aliases, or the `handler` of their object form.
 */
export function nitroHandlerFunctions(scope: ScriptScope): AnyNode[] {
  const handlers: AnyNode[] = [];
  walk(scope, scope.ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrapExpression(node.callee);
    if (
      callee?.type !== "Identifier" ||
      !HANDLER_FACTORIES.has(callee.name) ||
      !resolvesToImport(scope, callee, callee.name, HANDLER_MODULES)
    )
      return;
    const argument = unwrapExpression(node.arguments[0]);
    if (isFunction(argument)) handlers.push(argument);
    else if (argument?.type === "ObjectExpression") {
      const handler = argument.properties.find(
        (property: AnyNode) =>
          property.type === "Property" &&
          !property.computed &&
          property.key?.type === "Identifier" &&
          property.key.name === "handler",
      );
      const value = unwrapExpression(handler?.value);
      if (isFunction(value)) handlers.push(value);
    }
  });
  return handlers;
}

/** Visits every node under `node` in source order. */
export function walk(scope: ScriptScope, node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of scope.visitorKeys[node.type] ?? []) {
    const child = node[key];
    if (Array.isArray(child)) for (const item of child) walk(scope, item, visit);
    else walk(scope, child, visit);
  }
}

/**
 * Visits the nodes of a handler that run when the handler runs: its body without the bodies of
 * the functions it declares. `parent` is the node that holds each visited node.
 */
export function walkOwnBody(
  scope: ScriptScope,
  fn: AnyNode,
  visit: (node: AnyNode, parent: AnyNode) => void,
) {
  const visitNode = (node: AnyNode, parent: AnyNode) => {
    if (!node || typeof node.type !== "string") return;
    visit(node, parent);
    if (isFunction(node)) return;
    for (const key of scope.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) visitNode(item, node);
      else visitNode(child, node);
    }
  };
  visitNode(fn.body, fn);
}

export function reportNode(
  ctx: RuleContext,
  node: AnyNode,
  ruleId: string,
  severity: "error" | "warn",
  category: string,
  why: string,
  fix: string,
) {
  report(ctx, { start: node.range[0], end: node.range[1] }, ruleId, severity, category, why, fix);
}
