import { codeForRuleId, diagnosticForCode, type RuleContext } from "../../../core/index.js";
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

export { createRule } from "../../../core/index.js";
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

export function canUseNativeH3Source(ctx: RuleContext, source: unknown): boolean {
  return !ctx.project.runtimeGraph?.nuxtH3MayBeShimmed || source === "nitro/h3";
}

export function canUseNativeH3(ctx: RuleContext, node: AnyNode, includeTypes = false): boolean {
  const graph = ctx.project.runtimeGraph;
  if (!graph?.nuxtH3MayBeShimmed && graph?.nuxtH3AutoImports !== "legacy") return true;
  const expression = unwrap(node);
  const identifier =
    expression?.type === "MemberExpression" ? unwrap(expression.object) : expression;
  if (identifier?.type !== "Identifier") return false;
  const variable = resolveVariable(ctx, identifier);
  if (!variable) return graph.nuxtH3AutoImports === "native";
  const definition = variable.defs.find(
    (definition) =>
      definition.type === "ImportBinding" &&
      definition.parent.type === "ImportDeclaration" &&
      (includeTypes ||
        (definition.parent.importKind !== "type" &&
          (definition.node.type !== "ImportSpecifier" || definition.node.importKind !== "type"))),
  );
  return (
    definition?.type === "ImportBinding" &&
    definition.parent.type === "ImportDeclaration" &&
    canUseNativeH3Source(ctx, definition.parent.source.value)
  );
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
 * `createRouter()`, a chain of app methods on one, a binding initialized from one and never
 * reassigned, a parameter typed `H3`, or a `this.app` class field whose every initializer and
 * assignment in the class is one of these.
 */
export function isH3AppReceiver(
  ctx: RuleContext,
  node: AnyNode,
  nativeOnly = false,
  depth = 0,
): boolean {
  const expression = unwrap(node);
  if (!expression || depth > 16) return false;
  if (expression.type === "NewExpression")
    return (
      appClasses.has(h3ExportName(ctx, expression.callee) ?? "") &&
      (!nativeOnly || canUseNativeH3(ctx, expression.callee))
    );
  if (expression.type === "CallExpression") {
    if (appFactories.has(h3ExportName(ctx, expression.callee) ?? ""))
      return !nativeOnly || canUseNativeH3(ctx, expression.callee);
    const callee = unwrap(expression.callee);
    return (
      callee?.type === "MemberExpression" &&
      appChainMethods.has(memberName(callee) ?? "") &&
      isH3AppReceiver(ctx, callee.object, nativeOnly, depth + 1)
    );
  }
  if (expression.type === "MemberExpression")
    return isH3AppField(ctx, expression, nativeOnly, depth);
  if (expression.type !== "Identifier") return false;
  const variable = resolveVariable(ctx, expression);
  const init = constantInit(variable);
  if (init) return isH3AppReceiver(ctx, init, nativeOnly, depth + 1);
  return isH3AppParameter(ctx, variable, nativeOnly);
}

function isH3AppParameter(
  ctx: RuleContext,
  variable: ScopeVariable | null,
  nativeOnly: boolean,
): boolean {
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type !== "Parameter") return false;
  if (variable!.references.some((reference) => reference.isWrite())) return false;
  return isH3AppType(ctx, definition.name.typeAnnotation, nativeOnly);
}

/** Whether a type annotation names h3's `H3` or `H3Core` class, imported as a value or a type. */
function isH3AppType(ctx: RuleContext, annotation: AnyNode, nativeOnly: boolean): boolean {
  const type = annotation?.type === "TSTypeAnnotation" ? annotation.typeAnnotation : annotation;
  if (type?.type !== "TSTypeReference") return false;
  const name = type.typeName;
  if (nativeOnly && !canUseNativeH3(ctx, name?.left ?? name, true)) return false;
  if (name?.type === "Identifier") {
    const variable = resolveVariable(ctx, name);
    return appClasses.has(String(variable && h3Import(variable, true)));
  }
  if (name?.type !== "TSQualifiedName" || name.left?.type !== "Identifier") return false;
  const namespace = resolveVariable(ctx, name.left);
  return (
    appClasses.has(name.right?.name ?? "") &&
    !!namespace &&
    h3Import(namespace, true) === namespaceImport
  );
}

type FieldSource = { init: AnyNode } | { type: AnyNode };

interface ClassFields {
  start: number;
  end: number;
  fields: Map<string, FieldSource[]>;
}

function isH3AppField(
  ctx: RuleContext,
  member: AnyNode,
  nativeOnly: boolean,
  depth: number,
): boolean {
  if (unwrap(member.object)?.type !== "ThisExpression") return false;
  const name = fieldName(member);
  const at = offset(member);
  if (!name || at === undefined) return false;
  let owner: ClassFields | undefined;
  for (const item of classFields(ctx))
    if (item.start <= at && at < item.end && (!owner || item.start > owner.start)) owner = item;
  const sources = owner?.fields.get(name);
  if (!sources?.length) return false;
  return sources.every((source) =>
    "init" in source
      ? isH3AppReceiver(ctx, source.init, nativeOnly, depth + 1)
      : isH3AppType(ctx, source.type, nativeOnly),
  );
}

/** Each class's fields: their initializers, type annotations, and `this.field = value` writes. */
function classFields(ctx: RuleContext): readonly ClassFields[] {
  return perFile(ctx, "h3:class-fields", () => {
    const classes: ClassFields[] = [];
    const scope = fileScriptScope(ctx);
    if (!scope) return classes;
    const add = (owner: ClassFields | undefined, name: string | null, source: FieldSource) => {
      if (!owner || !name) return;
      const sources = owner.fields.get(name) ?? [];
      sources.push(source);
      owner.fields.set(name, sources);
    };
    const visit = (node: AnyNode, owner: ClassFields | undefined) => {
      if (!node?.type) return;
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        owner = { start: node.range[0], end: node.range[1], fields: new Map() };
        classes.push(owner);
      } else if (node.type === "PropertyDefinition" && !node.computed) {
        const name = fieldName({ property: node.key });
        if (node.value) add(owner, name, { init: node.value });
        if (node.typeAnnotation) add(owner, name, { type: node.typeAnnotation });
      } else if (node.type === "TSParameterProperty") {
        const parameter =
          node.parameter?.type === "AssignmentPattern" ? node.parameter.left : node.parameter;
        if (parameter?.type === "Identifier") {
          if (parameter.typeAnnotation)
            add(owner, parameter.name, { type: parameter.typeAnnotation });
          if (node.parameter.type === "AssignmentPattern")
            add(owner, parameter.name, { init: node.parameter.right });
        }
      } else if (
        node.type === "AssignmentExpression" &&
        node.left?.type === "MemberExpression" &&
        node.left.object?.type === "ThisExpression"
      ) {
        add(
          owner,
          fieldName(node.left),
          node.operator === "=" ? { init: node.right } : { init: null },
        );
      }
      for (const key of scope.visitorKeys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) for (const item of child) visit(item, owner);
        else visit(child, owner);
      }
    };
    try {
      visit(scope.ast, undefined);
    } catch {
      return [];
    }
    return classes;
  });
}

function fieldName(member: AnyNode): string | null {
  if (member.property?.type === "PrivateIdentifier") return `#${member.property.name}`;
  return memberName(member);
}

export interface H3Handler {
  /** The handler function node, from the file's scope analysis. */
  node: AnyNode;
  /** The local name of the handler's event parameter, when it is a plain identifier. */
  event?: string;
  bodyless?: boolean;
  native: boolean;
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
    const add = (
      candidate: AnyNode,
      bodyless = false,
      native = canUseNativeH3Source(ctx, undefined),
    ) => {
      const fn = handlerFunctionNode(ctx, candidate);
      const start = offset(fn);
      if (start === undefined) return;
      const existing = handlers.get(start);
      if (existing) {
        existing.bodyless &&= bodyless;
        existing.native &&= native;
        return;
      }
      const param = fn.params?.[0];
      handlers.set(start, {
        node: fn,
        bodyless,
        native,
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

/**
 * The binding of `fn`'s event parameter, when `fn` is an h3 handler, as `handlerFunctions` collects
 * them, whose first parameter is a plain identifier.
 */
export function handlerEventParam(ctx: RuleContext, fn: AnyNode): ScopeVariable | null {
  const handler = handlerFor(ctx, fn);
  const param = handler?.node.params?.[0];
  if (param?.type !== "Identifier") return null;
  try {
    const declared = fileScriptScope(ctx)?.scopeManager.getDeclaredVariables(handler!.node) ?? [];
    return declared.find((variable) => variable.defs.some((item) => item.name === param)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether `node` is an identifier bound to the event parameter of the h3 handler that declares
 * it. A local variable that shadows the name, or another function's parameter, is not.
 */
export function isHandlerEvent(ctx: RuleContext, node: AnyNode): boolean {
  const expression = unwrap(node);
  if (expression?.type !== "Identifier") return false;
  const variable = resolveVariable(ctx, expression);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type !== "Parameter") return false;
  return handlerEventParam(ctx, definition.node) === variable;
}

const transparentParents = new Set([
  "AwaitExpression",
  "ParenthesizedExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
]);

/**
 * Whether the value of `node`, a node of the Rule's visitor AST, is dropped: it is an expression
 * statement, a `void` operand, or a sequence item other than the last, directly or through
 * `await`, parentheses, the right side of `&&`/`||`/`??`, or a branch of a conditional.
 */
export function isDiscardedExpression(node: AnyNode): boolean {
  let current = node;
  for (let parent = parentOf(current); parent; current = parent, parent = parentOf(current)) {
    if (parent.type === "ExpressionStatement") return true;
    if (parent.type === "UnaryExpression") return parent.operator === "void";
    if (parent.type === "SequenceExpression") {
      if (parent.expressions.at(-1) !== current) return true;
    } else if (parent.type === "LogicalExpression") {
      if (parent.right !== current) return false;
    } else if (parent.type === "ConditionalExpression") {
      if (parent.test === current) return false;
    } else if (!transparentParents.has(parent.type)) return false;
  }
  return false;
}

function parentOf(node: AnyNode): AnyNode {
  return node?.__doctorParent ?? node?.parent;
}

/** The h3 runtime major version the file's package runs, when Doctor resolved it. */
export function h3Major(ctx: RuleContext, binding?: AnyNode): number | undefined {
  const graph = ctx.project.runtimeGraph;
  if (!canUseNativeH3(ctx, binding)) return undefined;
  const major = Number.parseInt(graph?.packages.h3?.version ?? "", 10);
  if (
    graph?.directH3 &&
    (graph.directH3.state !== "resolved" ||
      Number.parseInt(graph.directH3.version ?? "", 10) !== major)
  )
    return undefined;
  return Number.isFinite(major) ? major : undefined;
}

function collectHandlers(
  ctx: RuleContext,
  call: AnyNode,
  add: (node: AnyNode, bodyless?: boolean, native?: boolean) => void,
) {
  const name = h3ExportName(ctx, call.callee);
  if (name && handlerDefiners.has(name)) {
    const native = canUseNativeH3(ctx, call.callee);
    const input = unwrap(call.arguments?.[0]);
    if (input?.type === "ObjectExpression") {
      for (const property of input.properties ?? []) {
        if (property.type === "Property" && propertyKey(property) === "handler")
          add(property.value, false, native);
      }
    } else add(input, false, native);
    return;
  }
  const callee = unwrap(call.callee);
  if (
    callee?.type !== "MemberExpression" ||
    !appRouteMethods.has(memberName(callee) ?? "") ||
    !isH3AppReceiver(ctx, callee.object)
  )
    return;
  const method = memberName(callee);
  for (const argument of call.arguments ?? []) {
    add(
      argument,
      isFunctionNode(unwrap(argument)) && (method === "get" || method === "head"),
      canUseNativeH3Source(ctx, undefined) || isH3AppReceiver(ctx, callee.object, true),
    );
  }
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

function h3Import(
  variable: ScopeVariable,
  includeTypes = false,
): string | typeof namespaceImport | null {
  for (const definition of variable.defs) {
    if (definition.type !== "ImportBinding") continue;
    const declaration: AnyNode = definition.parent;
    const specifier: AnyNode = definition.node;
    if (
      declaration?.type !== "ImportDeclaration" ||
      (!includeTypes && (declaration.importKind === "type" || specifier.importKind === "type")) ||
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
  const autoImports =
    ctx.project.runtimeGraph?.nuxtH3AutoImports !== "disabled" && autoImportsH3(ctx);
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
