import { lt, major, valid } from "semver";
import type { DiagnosticEvidence, RuleContext } from "../../../../core/index.js";
import { findFunctionVar, findStatementBinding } from "./script-index.js";
import { getAsyncDataCall, getObjectPropertyValue, isFalseLiteral } from "./async-data.js";
import { FUNCTION_TYPES, isNonReference, propertyName } from "./nuxt-config-ast.js";
import { type AnyNode, createRule, sourceForNode, walkScriptLocal } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/fetch/cached-data-respects-refresh";
const FACTORIES = new Map([
  ["createUseFetch", "useFetch"],
  ["createUseAsyncData", "useAsyncData"],
]);
const WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
  "ChainExpression",
]);
// useFetch hashes these into its key, so a watch source that changes them also changes the key.
const FETCH_KEY_OPTIONS = ["key", "method", "baseURL", "query", "params", "body"];

interface Gate {
  source: "manifest" | "config" | "default";
  summary: string;
}

interface CachedRead {
  /** The function the getCachedData option resolves to. */
  fn: AnyNode;
  /** Source text of the payload or static data read it can return. */
  read: string;
}

interface DataCall {
  node: AnyNode;
  /** The composable as written at the call site, such as `useFetch` or a factory's name. */
  callee: string;
  family: "useFetch" | "useAsyncData";
  options: AnyNode;
  /** Factory options that also feed a useFetch key. */
  factoryOptions?: AnyNode;
}

export const cachedDataRespectsRefresh = createRule({
  meta: {
    id: RULE_ID,
    title: "Let getCachedData skip the cache when async data refreshes",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/going-further/experimental-features#granularcacheddata",
    requires: { script: true, nuxt: true },
    prefilter: { names: ["getCachedData"] },
  },
  create(ctx) {
    const gate = granularCachedDataGate(ctx);
    if (!gate) return;
    const reported = new Set<AnyNode>();
    const check = (call: DataCall, option: AnyNode, owner: string, subject: string) => {
      if (reported.has(option.value)) return;
      const cached = cachedRead(ctx, option);
      if (!cached) return;
      const refresh = refreshEvidence(ctx, call);
      if (!refresh) return;
      reported.add(option.value);
      ctx.report(
        diagnostics.NUXT0092({
          why: `getCachedData on ${owner} can return ${cached.read} without reading ctx.cause or nuxtApp.isHydrating. With experimental.granularCachedData, Nuxt also calls getCachedData for refresh(), execute(), refreshNuxtData() and watch, and uses any value it returns instead of running the handler. ${subject} ${refresh.summary}, so that refetch resolves with the cached value and never reaches the server while the key stays the same.`,
          fix: "Return cached data only for the first load or hydration, and undefined otherwise: getCachedData(key, nuxtApp, ctx) { if (ctx.cause !== 'initial' && !nuxtApp.isHydrating) return undefined; return nuxtApp.payload.data[key] ?? nuxtApp.static.data[key] }. Or remove getCachedData to use Nuxt's default, which already skips the cache on refresh.",
        }),
        {
          ruleId: RULE_ID,
          severity: ctx.severity,
          category: "fetching",
          file: ctx.file.path,
          range: ctx.range(option.value),
          confidence: gate.source === "manifest" ? "manifest-backed" : "heuristic-high",
          evidence: [
            { kind: gate.source === "manifest" ? "manifest" : "facts", summary: gate.summary },
            {
              kind: "ast",
              summary: `getCachedData returns ${cached.read} and never reads its third argument or nuxtApp.isHydrating.`,
              file: ctx.file.path,
              range: ctx.range(cached.fn),
            },
            {
              kind: "ast",
              summary: refresh.evidence,
              file: ctx.file.path,
              range: ctx.range(refresh.node),
            },
          ] satisfies DiagnosticEvidence[],
        },
      );
    };
    return {
      CallExpression(node: AnyNode) {
        const factory = factoryCall(ctx, node);
        if (factory) {
          const option = cachedDataOption(factory.options);
          if (!option || !factory.name) return;
          for (const call of factoryCalls(ctx, parentSkipping(node), factory.family)) {
            // A caller's own getCachedData replaces a default-mode factory option.
            if (!factory.overrides && cachedDataOption(call.options)) continue;
            check(
              { ...call, factoryOptions: factory.options },
              option,
              `the ${factory.name}() composable created by ${factory.callee}()`,
              `The ${factory.name}() call on line ${ctx.range(call.node)?.line ?? "?"}`,
            );
          }
          return;
        }
        const call = getAsyncDataCall(ctx, node);
        if (!call) return;
        const option = cachedDataOption(call.options);
        if (!option) return;
        check(
          {
            node,
            callee: call.name,
            family: call.name.endsWith("Fetch") ? "useFetch" : "useAsyncData",
            options: call.options,
          },
          option,
          `this ${call.name}() call`,
          "This call",
        );
      },
    };
  },
});

function granularCachedDataGate(ctx: RuleContext): Gate | null {
  const flag = ctx.project.nuxt?.granularCachedData;
  if (flag === null) return null;
  if (flag?.source === "manifest") {
    return flag.enabled
      ? {
          source: "manifest",
          summary: "The resolved Nuxt config enables experimental.granularCachedData.",
        }
      : null;
  }
  const nuxt = ctx.project.runtimeGraph?.packages.nuxt;
  const version = nuxt?.state === "resolved" && valid(nuxt.version) ? nuxt.version! : undefined;
  // Nuxt 3.17 added the flag; before it, getCachedData only ran for the first load.
  if (version && lt(version, "3.17.0")) return null;
  if (flag) {
    return flag.enabled
      ? { source: "config", summary: "nuxt.config sets experimental.granularCachedData to true." }
      : null;
  }
  if (!version) return null;
  if (major(version) >= 4) {
    return {
      source: "default",
      summary: `Nuxt ${version} enables experimental.granularCachedData by default and nuxt.config does not turn it off.`,
    };
  }
  // Nuxt 3 turns the flag on only for compatibilityVersion 4, and Doctor's own default assumes 4.
  const compatibility = ctx.project.nuxtCompatibility;
  if (
    compatibility?.state !== "resolved" ||
    compatibility.provenance === "default" ||
    compatibility.version !== 4
  )
    return null;
  return {
    source: "default",
    summary: `Nuxt ${version} with future.compatibilityVersion 4 enables experimental.granularCachedData by default.`,
  };
}

function factoryCall(ctx: RuleContext, node: AnyNode) {
  const callee = ctx.helpers.getCalleeName(node);
  const family = callee ? FACTORIES.get(callee) : undefined;
  if (!callee || !family) return null;
  const declarator = parentSkipping(node);
  const name =
    declarator?.type === "VariableDeclarator" && declarator.id?.type === "Identifier"
      ? (declarator.id.name as string)
      : undefined;
  const argument = unwrap(node.arguments?.[0]);
  // A function argument is override mode: its options win over the caller's.
  if (FUNCTION_TYPES.has(argument?.type)) {
    return {
      callee,
      name,
      family: family as DataCall["family"],
      options: returnedObject(argument),
      overrides: true,
    };
  }
  return {
    callee,
    name,
    family: family as DataCall["family"],
    options: argument?.type === "ObjectExpression" ? argument : null,
    overrides: false,
  };
}

function returnedObject(fn: AnyNode): AnyNode {
  const body = unwrap(fn.body);
  if (body?.type === "ObjectExpression") return body;
  if (body?.type !== "BlockStatement") return null;
  const returns = body.body.filter((statement: AnyNode) => statement.type === "ReturnStatement");
  const value = returns.length === 1 ? unwrap(returns[0].argument) : null;
  return value?.type === "ObjectExpression" ? value : null;
}

function factoryCalls(ctx: RuleContext, binding: AnyNode, family: DataCall["family"]): DataCall[] {
  const name = binding.id.name as string;
  const calls: DataCall[] = [];
  walkScriptLocal(ctx.file.scriptAst, (node) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") return;
    if (node.callee.name !== name || resolveBinding(node.callee) !== binding) return;
    calls.push({ node, callee: name, family, options: dataCallOptions(family, node) });
  });
  return calls;
}

function dataCallOptions(family: DataCall["family"], call: AnyNode): AnyNode {
  const args = call.arguments ?? [];
  const index =
    family === "useFetch"
      ? typeof unwrap(args[1])?.value === "string"
        ? 2
        : 1
      : args.length < 3 &&
          (resolveFunction(args[0], call) || unwrap(args[1])?.type === "ObjectExpression")
        ? 1
        : 2;
  const options = unwrap(args[index]);
  return options?.type === "ObjectExpression" ? options : null;
}

/** The getCachedData property that wins in an options object, unless a later spread can replace it. */
function cachedDataOption(options: AnyNode): AnyNode {
  let option: AnyNode = null;
  for (const property of options?.properties ?? []) {
    if (property.type === "SpreadElement") option = null;
    else if (propertyName(property) === "getCachedData") option = property;
    else if (property.computed) option = null;
  }
  return option;
}

function cachedRead(ctx: RuleContext, option: AnyNode): CachedRead | null {
  const fn = resolveFunction(option.value, option);
  if (!fn) return null;
  const params = fn.params ?? [];
  if (params.some((param: AnyNode) => param.type === "RestElement")) return null;
  const contextNames = new Set(patternNames(params[2]));
  let guarded = false;
  walkScriptLocal(fn.body, (node) => {
    if (guarded || node.type !== "Identifier") return;
    if (node.name === "isHydrating" || node.name === "arguments") guarded = true;
    else if (contextNames.has(node.name) && !isNonReference(node)) guarded = true;
  });
  if (guarded) return null;
  const nuxtApp = params[1]?.type === "Identifier" ? (params[1].name as string) : undefined;
  const locals = localConsts(fn);
  const visited = new Set<AnyNode>();
  for (const returned of returnedValues(fn)) {
    for (const value of possibleValues(returned, locals, visited)) {
      if (isCachedDataRead(value, nuxtApp, locals)) {
        return { fn, read: compact(sourceForNode(value, ctx.file.text)) };
      }
    }
  }
  return null;
}

function resolveFunction(value: AnyNode, from: AnyNode): AnyNode {
  const node = unwrap(value);
  if (FUNCTION_TYPES.has(node?.type)) return node;
  if (node?.type !== "Identifier") return null;
  const binding = resolveBinding(node, from);
  if (binding?.type === "FunctionDeclaration") return binding;
  if (binding?.type !== "VariableDeclarator" || binding.__doctorParent?.kind !== "const")
    return null;
  const init = unwrap(binding.init);
  return FUNCTION_TYPES.has(init?.type) ? init : null;
}

/** Resolve lexical identity, including bindings that shadow a result or factory. */
function resolveBinding(node: AnyNode, from: AnyNode = node): AnyNode {
  for (let scope = from.__doctorParent; scope; scope = scope.__doctorParent) {
    if (FUNCTION_TYPES.has(scope.type)) {
      const param = (scope.params ?? []).find((param: AnyNode) =>
        patternNames(param).includes(node.name),
      );
      if (param) return param;
      if (scope.id?.name === node.name) return scope;
      const variable = findFunctionVar(scope.body, node.name);
      if (variable) return variable;
    }
    if (scope.type === "CatchClause" && patternNames(scope.param).includes(node.name))
      return scope.param;
    const binding = findStatementBinding(scope, node.name);
    if (binding) return binding;
  }
  return null;
}

function patternNames(node: AnyNode): string[] {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "AssignmentPattern") return patternNames(node.left);
  if (node.type === "RestElement") return patternNames(node.argument);
  if (node.type === "ArrayPattern") return node.elements.flatMap(patternNames);
  if (node.type === "ObjectPattern")
    return node.properties.flatMap((item: AnyNode) => patternNames(item.value ?? item.argument));
  return [];
}

/** Values the function returns, without entering nested functions. */
function returnedValues(fn: AnyNode): AnyNode[] {
  if (fn.body?.type !== "BlockStatement") return [fn.body];
  const values: AnyNode[] = [];
  visitOwnBody(fn.body, (node) => {
    if (node.type === "ReturnStatement" && node.argument) values.push(node.argument);
  });
  return values;
}

function localConsts(fn: AnyNode): Map<string, AnyNode> {
  const locals = new Map<string, AnyNode>();
  if (fn.body?.type !== "BlockStatement") return locals;
  visitOwnBody(fn.body, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declarator of node.declarations) {
      if (declarator.id?.type === "Identifier" && !locals.has(declarator.id.name))
        locals.set(declarator.id.name, declarator.init);
    }
  });
  return locals;
}

function visitOwnBody(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visitOwnBody(child, visit);
    return;
  }
  if (typeof node.type !== "string" || FUNCTION_TYPES.has(node.type)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    if (value && typeof value === "object") visitOwnBody(value, visit);
  }
}

function possibleValues(
  node: AnyNode,
  locals: Map<string, AnyNode>,
  visited: Set<AnyNode>,
): AnyNode[] {
  const value = unwrap(node);
  if (!value || visited.has(value)) return [];
  visited.add(value);
  if (value.type === "LogicalExpression") {
    const right = possibleValues(value.right, locals, visited);
    return value.operator === "&&"
      ? right
      : [...possibleValues(value.left, locals, visited), ...right];
  }
  if (value.type === "ConditionalExpression") {
    return [
      ...possibleValues(value.consequent, locals, visited),
      ...possibleValues(value.alternate, locals, visited),
    ];
  }
  if (value.type === "SequenceExpression") {
    return possibleValues(value.expressions.at(-1), locals, visited);
  }
  if (value.type === "Identifier" && locals.has(value.name)) {
    return possibleValues(locals.get(value.name), locals, visited);
  }
  return [value];
}

// Matches `<nuxtApp>.payload.data[...]` and `<nuxtApp>.static.data[...]`.
function isCachedDataRead(
  node: AnyNode,
  nuxtApp: string | undefined,
  locals: Map<string, AnyNode>,
): boolean {
  if (node?.type !== "MemberExpression") return false;
  const data = unwrap(node.object);
  if (data?.type !== "MemberExpression" || memberName(data) !== "data") return false;
  const store = unwrap(data.object);
  if (store?.type !== "MemberExpression") return false;
  if (memberName(store) !== "payload" && memberName(store) !== "static") return false;
  return isNuxtApp(unwrap(store.object), nuxtApp, locals);
}

function isNuxtApp(
  node: AnyNode,
  nuxtApp: string | undefined,
  locals: Map<string, AnyNode>,
): boolean {
  if (node?.type === "CallExpression") {
    return node.callee?.type === "Identifier" && node.callee.name === "useNuxtApp";
  }
  if (node?.type !== "Identifier") return false;
  if (node.name === nuxtApp) return true;
  const local = unwrap(locals.get(node.name));
  return local?.type === "CallExpression" && isNuxtApp(local, undefined, new Map());
}

function memberName(node: AnyNode): string | null {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return null;
}

function refreshEvidence(
  ctx: RuleContext,
  call: DataCall,
): { summary: string; evidence: string; node: AnyNode } | null {
  const command = refreshCommand(ctx, call.node);
  if (command) {
    return {
      summary: `exposes ${command.name}()`,
      evidence: `The ${call.callee}() result's ${command.name} is read, so the data is refreshed on demand.`,
      node: command.node,
    };
  }
  const key = staticKey(call);
  const watch = getObjectPropertyValue(call.options, "watch");
  const watched = unwrap(watch);
  if (
    watch &&
    !isFalseLiteral(watch) &&
    !(watched?.type === "ArrayExpression" && watched.elements.length === 0) &&
    key !== undefined
  ) {
    return {
      summary: "passes watch, and its key does not change when the watched sources do",
      evidence: `${call.callee}() passes watch with a static key, so a watch trigger refetches the same key.`,
      node: watch,
    };
  }
  const refresh = refreshNuxtDataCall(ctx, key ?? undefined);
  if (refresh) {
    const target = compact(sourceForNode(refresh, ctx.file.text));
    return {
      summary: `is refreshed by ${target} in this file`,
      evidence: `${target} in this file refreshes the ${call.callee}() data.`,
      node: refresh,
    };
  }
  return null;
}

/** `refresh` or `execute` read from the call's result. */
function refreshCommand(ctx: RuleContext, call: AnyNode): { name: string; node: AnyNode } | null {
  const declarator = parentSkipping(call, "AwaitExpression");
  if (declarator?.type !== "VariableDeclarator") return null;
  if (declarator.id?.type === "ObjectPattern") {
    for (const property of declarator.id.properties ?? []) {
      const name = property.type === "Property" ? propertyName(property) : null;
      if (name === "refresh" || name === "execute") return { name, node: property };
    }
    return null;
  }
  if (declarator.id?.type !== "Identifier") return null;
  const result = declarator.id.name;
  let found: { name: string; node: AnyNode } | null = null;
  walkScriptLocal(ctx.file.scriptAst, (node) => {
    if (found || node.type !== "MemberExpression") return;
    if (unwrap(node.object)?.type !== "Identifier" || unwrap(node.object).name !== result) return;
    if (resolveBinding(unwrap(node.object)) !== declarator) return;
    const name = memberName(node);
    if (name === "refresh" || name === "execute") found = { name, node };
  });
  return found;
}

/** The call's key when Doctor can prove it never changes; `null` for a static but unknown key. */
function staticKey(call: DataCall): string | null | undefined {
  const args = call.node.arguments ?? [];
  if (call.family === "useAsyncData") {
    const first = unwrap(args[0]);
    // Nuxt injects a fixed key for the call site when the handler comes first.
    if (FUNCTION_TYPES.has(first?.type)) return null;
    return staticString(first);
  }
  const sources = [call.factoryOptions, call.options].filter(Boolean);
  if (
    sources.some((options) =>
      options.properties.some(
        (property: AnyNode) => property.type !== "Property" || property.computed,
      ),
    )
  )
    return undefined;
  const key =
    getObjectPropertyValue(call.options, "key") ??
    getObjectPropertyValue(call.factoryOptions, "key");
  if (key) return staticString(key);
  if (staticString(args[0]) === undefined) return undefined;
  if (!sources.every((options) => staticOptions(options, FETCH_KEY_OPTIONS))) return undefined;
  return null;
}

function staticOptions(options: AnyNode, names: string[]): boolean {
  return names.every((name) => {
    const value = getObjectPropertyValue(options, name);
    return !value || isStaticValue(value);
  });
}

function isStaticValue(node: AnyNode): boolean {
  const value = unwrap(node);
  if (!value) return false;
  if (value.type === "Literal") return true;
  if (value.type === "TemplateLiteral") return value.expressions.length === 0;
  if (value.type === "UnaryExpression") return isStaticValue(value.argument);
  if (value.type === "ArrayExpression")
    return value.elements.every((element: AnyNode) => element && isStaticValue(element));
  if (value.type === "ObjectExpression") {
    return value.properties.every(
      (property: AnyNode) =>
        property.type === "Property" && !property.computed && isStaticValue(property.value),
    );
  }
  return false;
}

function staticString(node: AnyNode): string | undefined {
  const value = unwrap(node);
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  if (value?.type === "TemplateLiteral" && value.expressions.length === 0)
    return value.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** A `refreshNuxtData()` call that refreshes every key, or one that names `key`. */
function refreshNuxtDataCall(ctx: RuleContext, key: string | undefined): AnyNode {
  let found: AnyNode = null;
  walkScriptLocal(ctx.file.scriptAst, (node) => {
    if (found || !ctx.helpers.isCall(node, "refreshNuxtData")) return;
    const first = unwrap(node.arguments?.[0]);
    if (!first) found = node;
    else if (key === undefined) return;
    else if (staticString(first) === key) found = node;
    else if (
      first.type === "ArrayExpression" &&
      first.elements.some((element: AnyNode) => staticString(element) === key)
    )
      found = node;
  });
  return found;
}

function parentSkipping(node: AnyNode, ...types: string[]): AnyNode {
  let parent = node.__doctorParent;
  while (parent && (WRAPPER_TYPES.has(parent.type) || types.includes(parent.type)))
    parent = parent.__doctorParent;
  return parent;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (current && WRAPPER_TYPES.has(current.type)) current = current.expression;
  return current ?? null;
}

function compact(source: string): string {
  const text = source.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
