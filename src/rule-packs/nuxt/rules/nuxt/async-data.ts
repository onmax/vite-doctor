import type { RuleContext } from "../../../../core/index.js";
import {
  findAncestor,
  resolveLocalCalleeName,
  sourceForNode,
  walkScriptLocal,
  type AnyNode,
} from "./shared.js";

export const ASYNC_DATA_COMPOSABLES = new Set([
  "useFetch",
  "useLazyFetch",
  "useAsyncData",
  "useLazyAsyncData",
]);

export const FETCH_ASYNC_DATA_COMPOSABLES = new Set(["useFetch", "useLazyFetch"]);

export const MUTATING_METHODS = new Set(["PATCH", "PUT", "DELETE"]);
export const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
export const DEFAULT_WRITE_LIKE_PATH_SEGMENTS = [
  "create",
  "save",
  "update",
  "delete",
  "send",
  "submit",
  "trigger",
  "run",
  "job",
  "recalculate",
  "settings",
];

export type ReplayableFindingConfidence =
  | "proven-write"
  | "explicit-replay-risk"
  | "heuristic-side-effect";

export interface AsyncDataRuleOptions {
  readonlyPaths?: string[];
  writeLikePathSegments?: string[];
  sideEffectCallees?: string[];
  allowPreviewBroadEnablementWithExplicitCallbacks?: boolean;
}

export interface AsyncDataCall {
  node: AnyNode;
  name: string;
  options: AnyNode;
  handler: AnyNode;
  method: string | null;
  path: string | null;
  hasImmediateFalse: boolean;
  hasExplicitKey: boolean;
  readonlyMarked: boolean;
}

export interface SideEffectMatch {
  node: AnyNode;
  kind: "mutating-fetch" | "toast" | "navigation" | "refresh" | "store-write" | "analytics";
  confidence: ReplayableFindingConfidence;
  method?: string | null;
  path?: string | null;
}

export function asyncDataRuleOptions(ctx: RuleContext): AsyncDataRuleOptions {
  return (ctx.options ?? {}) as AsyncDataRuleOptions;
}

export function replayableSeverity(
  confidence: ReplayableFindingConfidence,
  fallback: "warn" | "error" = "warn",
): "warn" | "error" {
  return confidence === "proven-write" ? "error" : fallback;
}

export function getAsyncDataCall(ctx: RuleContext, node: AnyNode): AsyncDataCall | null {
  if (!ctx.helpers.isCall(node)) return null;
  const name = resolveLocalCalleeName(ctx, node);
  if (!name || !ASYNC_DATA_COMPOSABLES.has(name)) return null;
  const options = getAsyncDataOptions(name, node);
  return {
    node,
    name,
    options,
    handler: getAsyncDataHandler(name, node),
    method: resolveHttpMethod(getObjectPropertyValue(options, "method")),
    path: getStaticRequestPath(node.arguments?.[0]),
    hasImmediateFalse: isFalseLiteral(getObjectPropertyValue(options, "immediate")),
    hasExplicitKey: hasExplicitAsyncDataKey(name, node, options),
    readonlyMarked: hasReadonlyMarker(ctx, node, options),
  };
}

export function getFetchOptions(call: AnyNode): AnyNode {
  return objectExpression(call?.arguments?.[1]);
}

export function resolveHttpMethod(node: AnyNode): string | null {
  const value = getStaticString(node);
  return value ? value.toUpperCase() : null;
}

export function getStaticString(node: AnyNode): string | null {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) return null;
  if (
    (unwrapped.type === "Literal" || unwrapped.type === "StringLiteral") &&
    typeof unwrapped.value === "string"
  )
    return unwrapped.value;
  if (unwrapped.type === "TemplateLiteral" && (unwrapped.expressions?.length ?? 0) === 0) {
    const quasi = unwrapped.quasis?.[0];
    return quasi?.value?.cooked ?? quasi?.value?.raw ?? null;
  }
  if (isMemberExpression(unwrapped)) return staticMemberPropertyName(unwrapped);
  return null;
}

export function getStaticRequestPath(node: AnyNode): string | null {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) return null;
  if (isFunctionNode(unwrapped)) return getReturnedStaticRequestPath(unwrapped);
  if (unwrapped.type === "TemplateLiteral" && (unwrapped.expressions?.length ?? 0) > 0)
    return templateLiteralPattern(unwrapped);
  return getStaticString(unwrapped);
}

export function getObjectPropertyValue(objectNode: AnyNode, key: string): AnyNode {
  if (!objectNode || objectNode.type !== "ObjectExpression") return null;
  for (const property of objectNode.properties ?? []) {
    if (property.type === "SpreadElement" || property.type === "SpreadProperty") continue;
    if (propertyKeyName(property) === key) return property.value ?? property.argument ?? null;
  }
  return null;
}

export function hasObjectProperty(objectNode: AnyNode, key: string): boolean {
  return Boolean(getObjectPropertyValue(objectNode, key));
}

export function isFalseLiteral(node: AnyNode): boolean {
  const unwrapped = unwrapExpression(node);
  return (
    (unwrapped?.type === "Literal" || unwrapped?.type === "BooleanLiteral") &&
    unwrapped.value === false
  );
}

export function hasGlobalRefreshIntentionalMarker(ctx: RuleContext, node: AnyNode): boolean {
  return (
    hasNearbyMarker(ctx, node, "nuxt-doctor: global-refresh-intentional") ||
    hasNearbyGlobalRefreshJustification(ctx, node)
  );
}

export function getDestructuredAsyncDataCommands(call: AnyNode): Set<string> {
  const parent = call.__doctorParent ?? call.parent;
  if (parent?.type !== "VariableDeclarator" || parent.id?.type !== "ObjectPattern")
    return new Set();
  const names = new Set<string>();
  for (const property of parent.id.properties ?? []) {
    const name = propertyKeyName(property);
    if (name === "execute" || name === "refresh") names.add(name);
  }
  return names;
}

export function isQueryLikePath(path: string | null): boolean {
  if (!path) return false;
  return /(?:^|\/)(query|search)(?:\/|$)|\/details\/query(?:\/|$)/i.test(path);
}

export function isReadonlyPath(path: string | null, options: AsyncDataRuleOptions): boolean {
  return Boolean(
    path && (options.readonlyPaths ?? []).some((pattern) => pathMatches(pattern, path)),
  );
}

export function isWriteLikePath(path: string | null, options: AsyncDataRuleOptions): boolean {
  if (!path) return false;
  const segments = options.writeLikePathSegments ?? DEFAULT_WRITE_LIKE_PATH_SEGMENTS;
  return path
    .split(/[/?#]+/)
    .flatMap((part) => part.split("-"))
    .some((part) => segments.some((segment) => part.toLowerCase() === segment.toLowerCase()));
}

export function collectReplayableSideEffects(ctx: RuleContext, root: AnyNode): SideEffectMatch[] {
  const matches: SideEffectMatch[] = [];
  const options = asyncDataRuleOptions(ctx);
  const extraSideEffectCallees = new Set(options.sideEffectCallees ?? []);
  const storeIdentifiers = collectLocalStoreIdentifiers(ctx);
  const syncInvokedFunctions = collectSyncInvokedNestedFunctions(root);
  walkScriptLocal(root, (node) => {
    if (node === root) return;
    if (isInsideDeferredCallback(root, node)) return;
    if (isInsideUninvokedNestedFunction(root, node, syncInvokedFunctions)) return;
    if (hasDeferredCallbackPrefix(ctx, node)) return;

    if (node.type === "AssignmentExpression" && isStoreMember(node.left, storeIdentifiers)) {
      matches.push({ node, kind: "store-write", confidence: "heuristic-side-effect" });
      return;
    }
    if (!ctx.helpers.isCall(node)) return;

    const callee = ctx.helpers.getCalleeName(node) ?? "";
    if (callee === "$fetch") {
      const method = resolveHttpMethod(getObjectPropertyValue(getFetchOptions(node), "method"));
      if (method && WRITE_METHODS.has(method)) {
        matches.push({
          node,
          kind: "mutating-fetch",
          method,
          path: getStaticRequestPath(node.arguments?.[0]),
          confidence: "proven-write",
        });
      }
      return;
    }
    if (callee === "toast.add") {
      matches.push({ node, kind: "toast", confidence: "heuristic-side-effect" });
      return;
    }
    if (callee === "navigateTo") {
      matches.push({ node, kind: "navigation", confidence: "heuristic-side-effect" });
      return;
    }
    if (callee === "refreshNuxtData") {
      matches.push({ node, kind: "refresh", confidence: "explicit-replay-risk" });
      return;
    }
    if (callee === "analytics.track" || callee === "trackEvent" || callee === "eventBus.emit") {
      matches.push({ node, kind: "analytics", confidence: "heuristic-side-effect" });
      return;
    }
    if (callee.endsWith(".$patch"))
      matches.push({ node, kind: "store-write", confidence: "heuristic-side-effect" });
    if (extraSideEffectCallees.has(callee))
      matches.push({ node, kind: "analytics", confidence: "heuristic-side-effect" });
  });
  return dedupeSideEffects(matches);
}

export function hasKeyedRefreshNuxtDataCall(ctx: RuleContext): boolean {
  let hasKeyedRefresh = false;
  walkScriptLocal(ctx.file.scriptAst, (node) => {
    if (hasKeyedRefresh || !ctx.helpers.isCall(node, "refreshNuxtData")) return;
    const first = node.arguments?.[0];
    if (!first) return;
    if (getStaticString(first) || first.type === "ArrayExpression") hasKeyedRefresh = true;
  });
  return hasKeyedRefresh;
}

export function isInsideRouteHook(ctx: RuleContext, node: AnyNode): boolean {
  return (
    findAncestor(node, (parent) => {
      if (!ctx.helpers.isCall(parent)) return false;
      const name = ctx.helpers.getCalleeName(parent) ?? "";
      return /(?:^|\.)afterEach$|(?:^|\.)beforeEach$|(?:^|\.)beforeResolve$/.test(name);
    }) !== null
  );
}

function getAsyncDataOptions(name: string, call: AnyNode): AnyNode {
  if (FETCH_ASYNC_DATA_COMPOSABLES.has(name)) return objectExpression(call.arguments?.[1]);
  const first = unwrapExpression(call.arguments?.[0]);
  if (isFunctionNode(first)) return objectExpression(call.arguments?.[1]);
  return objectExpression(call.arguments?.[2]);
}

function getAsyncDataHandler(name: string, call: AnyNode): AnyNode {
  if (FETCH_ASYNC_DATA_COMPOSABLES.has(name)) return null;
  const first = unwrapExpression(call.arguments?.[0]);
  if (isFunctionNode(first)) return first;
  const second = unwrapExpression(call.arguments?.[1]);
  return isFunctionNode(second) ? second : null;
}

function hasExplicitAsyncDataKey(name: string, call: AnyNode, options: AnyNode): boolean {
  if (FETCH_ASYNC_DATA_COMPOSABLES.has(name))
    return Boolean(getObjectPropertyValue(options, "key"));
  const first = unwrapExpression(call.arguments?.[0]);
  return Boolean(first && !isFunctionNode(first));
}

function hasReadonlyMarker(ctx: RuleContext, call: AnyNode, options: AnyNode): boolean {
  if (hasNearbyMarker(ctx, call, "nuxt-doctor: async-data-readonly")) return true;
  const meta = getObjectPropertyValue(options, "meta");
  return isTrueLiteral(getObjectPropertyValue(meta, "readonly"));
}

function hasNearbyMarker(ctx: RuleContext, node: AnyNode, marker: string): boolean {
  const source = sourceForNode(node, ctx.file.text);
  if (source.includes(marker)) return true;
  const start = node.start ?? node.range?.[0] ?? 0;
  const previousLineStart = ctx.file.text.lastIndexOf("\n", Math.max(0, start - 2)) + 1;
  const before = ctx.file.text.slice(previousLineStart, start);
  return before.includes(marker);
}

function hasNearbyGlobalRefreshJustification(ctx: RuleContext, node: AnyNode): boolean {
  const start = node.start ?? node.range?.[0] ?? 0;
  const nearbyLines = ctx.file.text.slice(0, start).split(/\r?\n/).slice(-12);
  const comments = nearbyLines
    .map((line) => line.match(/^\s*\/\/\s?(.*)$/)?.[1] ?? "")
    .filter(Boolean)
    .join(" ");
  return /(?:refresh|refetch)\s+(?:all|every|global)[\w\s-]{0,80}(?:async[-\s]?data|data)|(?:global|all|every)[\w\s-]{0,80}(?:async[-\s]?data|data)[\w\s-]{0,80}(?:refresh|refetch)/i.test(
    comments,
  );
}

function objectExpression(node: AnyNode): AnyNode {
  const unwrapped = unwrapExpression(node);
  return unwrapped?.type === "ObjectExpression" ? unwrapped : null;
}

function unwrapExpression(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ChainExpression")
  ) {
    current = current.expression;
  }
  return current ?? null;
}

function propertyKeyName(property: AnyNode): string | null {
  const key = property?.key;
  if (!key) return null;
  if (!property.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" || key.type === "StringLiteral") return String(key.value);
  return null;
}

function isMemberExpression(node: AnyNode): boolean {
  return node.type === "MemberExpression" || node.type === "StaticMemberExpression";
}

function staticMemberPropertyName(node: AnyNode): string | null {
  const property = node.property;
  if (!property) return null;
  if (!node.computed && property.type === "Identifier") return property.name;
  if (property.type === "Literal" || property.type === "StringLiteral")
    return String(property.value);
  return null;
}

function isFunctionNode(node: AnyNode): boolean {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

function getReturnedStaticRequestPath(node: AnyNode): string | null {
  const body = unwrapExpression(node.body);
  if (!body) return null;
  if (body.type !== "BlockStatement") return getStaticRequestPath(body);
  const returns = (body.body ?? []).filter((item: AnyNode) => item.type === "ReturnStatement");
  if (returns.length !== 1) return null;
  return getStaticRequestPath(returns[0]?.argument);
}

function templateLiteralPattern(node: AnyNode): string | null {
  const quasis = node.quasis ?? [];
  if (!quasis.length) return null;
  let pattern = "";
  for (let index = 0; index < quasis.length; index += 1) {
    const quasi = quasis[index];
    pattern += quasi?.value?.cooked ?? quasi?.value?.raw ?? "";
    if (index < (node.expressions?.length ?? 0)) pattern += "*";
  }
  return pattern || null;
}

function isTrueLiteral(node: AnyNode): boolean {
  const unwrapped = unwrapExpression(node);
  return (
    (unwrapped?.type === "Literal" || unwrapped?.type === "BooleanLiteral") &&
    unwrapped.value === true
  );
}

function isStoreMember(node: AnyNode, storeIdentifiers: Set<string>): boolean {
  if (!isMemberExpression(node)) return false;
  const object = node.object;
  return object?.type === "Identifier" && storeIdentifiers.has(object.name);
}

function isInsideUninvokedNestedFunction(
  root: AnyNode,
  node: AnyNode,
  syncInvokedFunctions: Set<AnyNode>,
): boolean {
  let current = node.__doctorParent ?? node.parent;
  while (current && current !== root) {
    if (isFunctionNode(current)) {
      const parent = current.__doctorParent ?? current.parent;
      if (parent?.type === "CallExpression" && parent.callee !== current) return true;
      return !syncInvokedFunctions.has(current);
    }
    current = current.__doctorParent ?? current.parent;
  }
  return false;
}

function isInsideDeferredCallback(root: AnyNode, node: AnyNode): boolean {
  return (
    findAncestor(node, (parent) => {
      if (parent === root || !isFunctionNode(parent)) return false;
      const call = parent.__doctorParent ?? parent.parent;
      return call?.type === "CallExpression" && call.callee !== parent;
    }) !== null
  );
}

function hasDeferredCallbackPrefix(ctx: RuleContext, node: AnyNode): boolean {
  const start = node.start ?? node.range?.[0];
  if (typeof start !== "number") return false;
  const before = ctx.file.text.slice(Math.max(0, start - 160), start);
  return /(?:onMounted|onBeforeMount|watch|watchEffect|useEventListener|addEventListener)\s*\([^;\n]*=>\s*$/s.test(
    before,
  );
}

function collectLocalStoreIdentifiers(ctx: RuleContext): Set<string> {
  const names = new Set<string>();
  walkScriptLocal(ctx.file.scriptAst, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
    const init = unwrapExpression(node.init);
    const callee = ctx.helpers.getCalleeName(init) ?? "";
    if (/^use[A-Z]\w*Store$/.test(callee)) names.add(node.id.name);
  });
  return names;
}

function collectSyncInvokedNestedFunctions(root: AnyNode): Set<AnyNode> {
  const functionsByName = new Map<string, AnyNode>();
  const invoked = new Set<AnyNode>();

  walkScriptLocal(root, (node) => {
    if (node === root || isInsideUninvokedNestedFunction(root, node, new Set())) return;
    if (node.type === "FunctionDeclaration" && node.id?.name)
      functionsByName.set(node.id.name, node);
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      isFunctionNode(node.init)
    ) {
      functionsByName.set(node.id.name, node.init);
    }
  });

  walkScriptLocal(root, (node) => {
    if (node === root || isInsideUninvokedNestedFunction(root, node, new Set())) return;
    if (node.type !== "CallExpression") return;
    if (node.callee?.type === "Identifier") {
      const fn = functionsByName.get(node.callee.name);
      if (fn) invoked.add(fn);
    }
    if (isFunctionNode(node.callee)) invoked.add(node.callee);
  });

  return invoked;
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  let regex = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    regex += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`).test(path);
}

function dedupeSideEffects(matches: SideEffectMatch[]): SideEffectMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.kind}:${match.node.start ?? ""}:${match.node.end ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
