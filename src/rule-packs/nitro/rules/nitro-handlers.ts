import type { RuleContext } from "../../../core/index.js";
import type { ScriptScope } from "../../../core/internal/script-scope.js";
import { type AnyNode, report } from "./shared.js";
import { propertyKey } from "./server-layout.js";

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
const HANDLER_FACTORIES = [
  "defineEventHandler",
  "eventHandler",
  "defineHandler",
  "defineCachedEventHandler",
  "defineCachedHandler",
];
const HANDLER_MODULES = new Set([
  "h3",
  "nitro/h3",
  "nitro",
  "nitro/app",
  "nitro/cache",
  "nitropack/runtime",
  "#imports",
  "#internal/nitro",
]);
const STORAGE_MODULES = new Set([
  "nitropack/runtime",
  "#imports",
  "#internal/nitro",
  "nitro/storage",
  "nitro/kv",
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

export function memberName(member: AnyNode): string | undefined {
  if (member?.type !== "MemberExpression") return undefined;
  if (member.computed && member.property?.type !== "Literal") return undefined;
  return propertyKey(member.property) ?? undefined;
}

export function isStorageCall(scope: ScriptScope, node: AnyNode) {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") return false;
  const callee = unwrapExpression(call.callee);
  return (
    resolvesToImport(scope, callee, "useStorage", STORAGE_MODULES) ||
    resolvesToImport(scope, callee, "useKV", STORAGE_MODULES)
  );
}

export function constInitializer(scope: ScriptScope, identifier: AnyNode): AnyNode {
  if (identifier?.type !== "Identifier") return undefined;
  const defs = resolvedVariable(scope, identifier)?.defs;
  const definition = defs?.length === 1 ? defs[0] : undefined;
  if (
    definition?.type === "Variable" &&
    definition.parent?.kind === "const" &&
    definition.node.id.type === "Identifier"
  )
    return definition.node.init;
}

/**
 * Follow a registered file's default export to its function or factory callback.
 */
export function nitroHandlerFunctions(scope: ScriptScope): AnyNode[] {
  const seen = new Set<AnyNode>();
  const resolveHandler = (value: AnyNode): AnyNode => {
    const node = unwrapExpression(value);
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (isFunction(node)) return node;
    if (node.type === "Identifier") {
      const defs = resolvedVariable(scope, node)?.defs;
      if (defs?.length !== 1) return;
      const definition = defs[0]!;
      if (definition.type === "FunctionName") return definition.node;
      return resolveHandler(constInitializer(scope, node));
    }
    if (node.type !== "CallExpression") return;
    const callee = unwrapExpression(node.callee);
    if (!HANDLER_FACTORIES.some((name) => resolvesToImport(scope, callee, name, HANDLER_MODULES)))
      return;
    const argument = unwrapExpression(node.arguments[0]);
    if (argument?.type === "ObjectExpression") {
      const handler = argument.properties.findLast(
        (property: AnyNode) =>
          property.type === "Property" &&
          !property.computed &&
          propertyKey(property.key) === "handler",
      );
      return resolveHandler(handler?.value);
    }
    return resolveHandler(argument);
  };
  for (const statement of scope.ast.body) {
    const exported =
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement.type === "ExportNamedDeclaration" && !statement.source
          ? statement.specifiers.find(
              (specifier: AnyNode) => propertyKey(specifier.exported) === "default",
            )?.local
          : undefined;
    if (exported) {
      const handler = resolveHandler(exported);
      return handler ? [handler] : [];
    }
  }
  return [];
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
