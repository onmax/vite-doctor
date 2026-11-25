import {
  codeForRuleId,
  createRule,
  diagnosticForCode,
  type RuleContext,
} from "../../../core/index.js";
import type { AnyNode } from "../../../core/rule-authoring.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import {
  fileScriptScope,
  perFile,
  type ScopeReference,
  type ScopeVariable,
} from "../../../core/internal/script-scope.js";
import { isNitroRouteFile, isNitroServerFile } from "../../../core/internal/server-files.js";
import { diagnosticCodesByRuleId, diagnostics } from "../diagnostics.js";

export { createRule };
export {
  nearestFunctionOrProgram,
  sourceForNode,
  walkScriptLocal,
  type AnyNode,
} from "../../../core/rule-authoring.js";
export { isNitroRouteFile, isNitroServerFile };

export function report(
  ctx: RuleContext,
  node: AnyNode,
  ruleId: string,
  severity: any,
  category: string,
  message: string,
  suggestion: string,
) {
  const code = codeForRuleId(diagnosticCodesByRuleId, ruleId);
  if (!code) throw doctorInternalDiagnostics.DOC0013({ ruleId });
  const diagnostic = diagnosticForCode(diagnostics, code);
  if (!diagnostic) throw doctorInternalDiagnostics.DOC0013({ ruleId, code });
  ctx.helpers.report(ctx, node, diagnostic({ why: message, fix: suggestion }), {
    ruleId,
    severity,
    category,
  });
}

// h3's runtime entry points all export the same API; `h3/tracing` and `h3/rules` are other modules.
const h3Sources = new Set([
  "h3",
  "nitro/h3",
  "h3/node",
  "h3/bun",
  "h3/deno",
  "h3/cloudflare",
  "h3/service-worker",
  "h3/generic",
]);
const h3SourcePattern = /["'](?:h3|nitro\/h3|h3\/[\w-]+)["']/;

/** Whether an import source is one of h3's entry points, including Nitro's `nitro/h3`. */
export function isH3Source(source: unknown): boolean {
  return typeof source === "string" && h3Sources.has(source);
}

export interface H3ImportBindings {
  /** Local name → the h3 export it binds, for value imports. A default import maps to `default`. */
  named: ReadonlyMap<string, string>;
  /** Local names of `import * as h3 from "h3"` value imports. */
  namespaces: ReadonlySet<string>;
}

const noBindings: H3ImportBindings = { named: new Map(), namespaces: new Set() };

/** The file's value imports from h3. Type-only imports and type-only specifiers are left out. */
export function h3ImportBindings(ctx: RuleContext): H3ImportBindings {
  return perFile(ctx, "h3:import-bindings", () => {
    if (!h3SourcePattern.test(ctx.file.text)) return noBindings;
    const ast = fileScriptScope(ctx)?.ast;
    if (!ast) return noBindings;
    const named = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of ast.body ?? []) {
      if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
      if (!isH3Source(statement.source?.value)) continue;
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.importKind === "type") continue;
        if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);
        else named.set(specifier.local.name, importedName(specifier));
      }
    }
    return named.size || namespaces.size ? { named, namespaces } : noBindings;
  });
}

/**
 * Files whose code runs as h3 handlers: Nitro and Nuxt server files, where h3 utilities are
 * auto-imported, and other files with a value import from h3. Doctor leaves test files out of
 * Rules that do not declare `includeTestFiles`.
 */
export function isH3HandlerFile(ctx: RuleContext): boolean {
  if (autoImportsH3(ctx)) return true;
  const bindings = h3ImportBindings(ctx);
  return bindings.named.size > 0 || bindings.namespaces.size > 0;
}

/**
 * The h3 export an expression refers to: an identifier bound by a value import from h3, a member
 * of an h3 namespace import, or, in Nitro and Nuxt server files where h3 utilities are
 * auto-imported, a free identifier. A locally declared name never resolves.
 */
export function h3ExportName(ctx: RuleContext, node: AnyNode): string | null {
  const expression = unwrap(node);
  if (expression?.type === "Identifier") return resolveIdentifier(ctx, expression);
  if (expression?.type !== "MemberExpression") return null;
  const property = memberName(expression);
  const object = unwrap(expression.object);
  if (!property || object?.type !== "Identifier") return null;
  if (!h3ImportBindings(ctx).namespaces.has(object.name)) return null;
  const variable = resolveVariable(ctx, object);
  return variable && h3Import(variable) === namespaceImport ? property : null;
}

/** Whether `node` is a call of one of the named h3 exports, as `h3ExportName` resolves them. */
export function isH3Call(
  ctx: RuleContext,
  node: AnyNode,
  exportNames: readonly string[] | ReadonlySet<string>,
): boolean {
  if (node?.type !== "CallExpression") return false;
  const name = h3ExportName(ctx, node.callee);
  if (!name) return false;
  return Array.isArray(exportNames)
    ? exportNames.includes(name)
    : (exportNames as ReadonlySet<string>).has(name);
}

const appFactories = new Set(["createApp", "createRouter"]);
const appClasses = new Set(["H3", "H3Core"]);
const appRouteMethods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "connect",
  "trace",
  "all",
  "on",
  "use",
]);
const appChainMethods = new Set([...appRouteMethods, "mount", "register"]);

/**
 * Whether an expression refers to an h3 app or router: `new H3()`, `createApp()`,
 * `createRouter()`, a chain of app methods on one, or a binding initialized from one and never
 * reassigned.
 */
export function isH3AppReceiver(ctx: RuleContext, node: AnyNode, depth = 0): boolean {
  const expression = unwrap(node);
  if (!expression || depth > 16) return false;
  if (expression.type === "NewExpression")
    return appClasses.has(h3ExportName(ctx, expression.callee) ?? "");
  if (expression.type === "CallExpression") {
    if (appFactories.has(h3ExportName(ctx, expression.callee) ?? "")) return true;
    const callee = unwrap(expression.callee);
    return (
      callee?.type === "MemberExpression" &&
      appChainMethods.has(memberName(callee) ?? "") &&
      isH3AppReceiver(ctx, callee.object, depth + 1)
    );
  }
  if (expression.type !== "Identifier") return false;
  const init = constantInit(resolveVariable(ctx, expression));
  return init ? isH3AppReceiver(ctx, init, depth + 1) : false;
}

export interface H3Handler {
  /** The handler function node, from the file's scope analysis. */
  node: AnyNode;
  /** The local name of the handler's event parameter, when it is a plain identifier. */
  event?: string;
}

const handlerDefiners = new Set([
  "defineEventHandler",
  "defineHandler",
  "eventHandler",
  "defineMiddleware",
  "defineValidatedHandler",
]);

/**
 * The file's h3 handler functions, keyed by start offset: functions passed to an h3 handler
 * definer (directly or as `{ handler }`), to app and router methods, and functions default-exported
 * from Nitro and Nuxt server files.
 */
export function handlerFunctions(ctx: RuleContext): ReadonlyMap<number, H3Handler> {
  return perFile(ctx, "h3:handler-functions", () => {
    const handlers = new Map<number, H3Handler>();
    const scope = fileScriptScope(ctx);
    if (!scope) return handlers;
    const add = (candidate: AnyNode) => {
      const fn = handlerFunctionNode(ctx, candidate);
      const start = offset(fn);
      if (start === undefined || handlers.has(start)) return;
      const param = fn.params?.[0];
      handlers.set(start, {
        node: fn,
        event: param?.type === "Identifier" ? param.name : undefined,
      });
    };
    const nitroServerFile = autoImportsH3(ctx);
    try {
      const visit = (node: AnyNode) => {
        if (!node?.type) return;
        if (node.type === "CallExpression") collectHandlers(ctx, node, add);
        else if (node.type === "ExportDefaultDeclaration" && nitroServerFile) add(node.declaration);
        for (const key of scope.visitorKeys[node.type] ?? []) {
          const child = node[key];
          if (Array.isArray(child)) child.forEach(visit);
          else visit(child);
        }
      };
      visit(scope.ast);
    } catch {
      return handlers;
    }
    return handlers;
  });
}

/** The h3 handler that `fn` is, from `handlerFunctions`, if it is one. */
export function handlerFor(ctx: RuleContext, fn: AnyNode): H3Handler | undefined {
  const start = offset(fn);
  return start === undefined ? undefined : handlerFunctions(ctx).get(start);
}

/** Whether `fn` is an h3 handler function, as `handlerFunctions` collects them. */
export function isHandlerFunction(ctx: RuleContext, fn: AnyNode): boolean {
  return handlerFor(ctx, fn) !== undefined;
}

/** The h3 runtime major version the file's package runs, when Doctor resolved it. */
export function h3Major(ctx: RuleContext): number | undefined {
  const major = Number.parseInt(ctx.project.runtimeGraph?.packages.h3?.version ?? "", 10);
  return Number.isFinite(major) ? major : undefined;
}

function collectHandlers(ctx: RuleContext, call: AnyNode, add: (node: AnyNode) => void) {
  const name = h3ExportName(ctx, call.callee);
  if (name && handlerDefiners.has(name)) {
    const input = unwrap(call.arguments?.[0]);
    if (input?.type === "ObjectExpression") {
      for (const property of input.properties ?? []) {
        if (property.type === "Property" && propertyKey(property) === "handler")
          add(property.value);
      }
    } else add(input);
    return;
  }
  const callee = unwrap(call.callee);
  if (
    callee?.type !== "MemberExpression" ||
    !appRouteMethods.has(memberName(callee) ?? "") ||
    !isH3AppReceiver(ctx, callee.object)
  )
    return;
  for (const argument of call.arguments ?? []) add(argument);
}

function handlerFunctionNode(ctx: RuleContext, candidate: AnyNode): AnyNode {
  const node = unwrap(candidate);
  if (isFunctionNode(node)) return node;
  if (node?.type !== "Identifier") return null;
  const variable = resolveVariable(ctx, node);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type === "FunctionName") return definition.node;
  const init = unwrap(constantInit(variable));
  return isFunctionNode(init) ? init : null;
}

function isFunctionNode(node: AnyNode) {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

const namespaceImport = Symbol("h3 namespace import");

function h3Import(variable: ScopeVariable): string | typeof namespaceImport | null {
  for (const definition of variable.defs) {
    if (definition.type !== "ImportBinding") continue;
    const declaration: AnyNode = definition.parent;
    const specifier: AnyNode = definition.node;
    if (
      declaration?.type !== "ImportDeclaration" ||
      declaration.importKind === "type" ||
      specifier.importKind === "type" ||
      !isH3Source(declaration.source?.value)
    )
      continue;
    return specifier.type === "ImportNamespaceSpecifier"
      ? namespaceImport
      : importedName(specifier);
  }
  return null;
}

// Nitro and Nuxt auto-import h3 utilities into their server files.
export function autoImportsH3(ctx: RuleContext): boolean {
  return perFile(ctx, "h3:auto-imports", () => isNitroServerFile(ctx));
}

function resolveIdentifier(ctx: RuleContext, identifier: AnyNode): string | null {
  const autoImports = autoImportsH3(ctx);
  if (!autoImports && !h3ImportBindings(ctx).named.has(identifier.name)) return null;
  const references = referencesByOffset(ctx);
  if (!references) return autoImports ? identifier.name : null;
  const reference = references.get(offset(identifier) ?? -1);
  if (!reference) return null;
  if (!reference.resolved) return autoImports ? identifier.name : null;
  const imported = h3Import(reference.resolved);
  return typeof imported === "string" ? imported : null;
}

function resolveVariable(ctx: RuleContext, identifier: AnyNode): ScopeVariable | null {
  return referencesByOffset(ctx)?.get(offset(identifier) ?? -1)?.resolved ?? null;
}

function referencesByOffset(ctx: RuleContext): Map<number, ScopeReference> | null {
  return perFile(ctx, "h3:references", () => {
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

/** The initializer of a `const`-like binding with a single definition and no later writes. */
function constantInit(variable: ScopeVariable | null): AnyNode {
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type !== "Variable" || definition.node.id.type !== "Identifier") return null;
  const init = definition.node.init;
  if (!init) return null;
  const writes = variable!.references.filter((reference) => reference.isWrite());
  return writes.length <= 1 ? init : null;
}

function importedName(specifier: AnyNode): string {
  if (specifier.type === "ImportDefaultSpecifier") return "default";
  return specifier.imported?.name ?? String(specifier.imported?.value);
}

function memberName(node: AnyNode): string | null {
  if (!node.computed) return node.property?.type === "Identifier" ? node.property.name : null;
  const property = node.property;
  if (property?.type === "Literal" && typeof property.value === "string") return property.value;
  if (property?.type === "TemplateLiteral" && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  return null;
}

function propertyKey(property: AnyNode): string | null {
  if (!property.computed && property.key?.type === "Identifier") return property.key.name;
  return property.key?.type === "Literal" ? String(property.key.value) : null;
}

function unwrap(node: AnyNode): AnyNode {
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

function offset(node: AnyNode): number | undefined {
  return node?.start ?? node?.range?.[0];
}
