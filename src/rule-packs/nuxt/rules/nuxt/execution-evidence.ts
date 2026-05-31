import type { RuleContext } from "../../../../core/index.js";
import {
  findAncestor,
  nearestFunctionOrProgram,
  sourceForNode,
  walkScriptLocal,
  type AnyNode,
} from "../../../../core/rule-authoring.js";

export type NuxtExecutionEvidence =
  | "setup-time"
  | "event-handler"
  | "returned-command"
  | "lifecycle-only"
  | "client-only"
  | "server-only"
  | "unknown";

const TEMPLATE_BLOCK_RE = /<template[^>]*>([\s\S]*?)<\/template>/;
const TEMPLATE_DIRECTIVE_RE_G = /[@:]\w+(?:\.[\w.]+)?\s*=\s*["']([^"']+)["']/g;
const TEMPLATE_EVENT_RE_G = /@\w+(?:\.[\w.]+)?\s*=\s*["']([^"']+)["']/g;
const IDENT_RE_G = /\b[A-Za-z_$][\w$]*\b/g;
const CLIENT_CALLBACK_RE =
  /^(useEventListener|addEventListener|onKeyDown|onKeyUp|onKeyStroke|onClickOutside|onLongPress|usePointerSwipe|useSwipe|useIntersectionObserver|useResizeObserver|useMutationObserver|defineShortcuts)$/;
const CLIENT_LIFECYCLE_RE = /^(onMounted|onBeforeMount|onBeforeUnmount|onUnmounted)$/;
const LIFECYCLE_RE =
  /^(onMounted|onBeforeMount|onBeforeUnmount|onUnmounted|watch|watchEffect|watchPostEffect|nextTick)$/;
const COMMAND_LIKE_RE =
  /^(on[A-Z]|handle|handler|callback|execute|run|open|close|toggle|submit|select|copy|download|navigate|scroll)/;

export function isClientOnlyPath(path: string) {
  return /\.client\.[cm]?[jt]sx?$/.test(path) || path.includes(".client.vue");
}

export function classifyExecutionEvidence(ctx: RuleContext, node: AnyNode): NuxtExecutionEvidence {
  if (!node || typeof node !== "object") return computeExecutionEvidence(ctx, node);
  const cache = getEvidenceCache(ctx);
  const hit = cache.get(node);
  if (hit) return hit;
  const result = computeExecutionEvidence(ctx, node);
  cache.set(node, result);
  return result;
}

export function isSsrExecutedEvidence(ctx: RuleContext, node: AnyNode) {
  const evidence = classifyExecutionEvidence(ctx, node);
  return evidence === "setup-time" || evidence === "unknown";
}

export function isClientCallableEvidence(ctx: RuleContext, node: AnyNode) {
  const evidence = classifyExecutionEvidence(ctx, node);
  return (
    evidence === "client-only" || evidence === "event-handler" || evidence === "returned-command"
  );
}

export function isPayloadSerializedEvidence(ctx: RuleContext, node: AnyNode) {
  return (
    !isClientOnlyPath(ctx.file.relativePath) &&
    classifyExecutionEvidence(ctx, node) !== "client-only"
  );
}

export function isReusableDataComposableContext(ctx: RuleContext, node: AnyNode) {
  if (/^app\/composables\/use[A-Z]\w+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return true;
  return isInsideExportedFunction(ctx.file.text, node.start ?? 0);
}

export function isSourceOnlyExecutionEvidence(ctx: RuleContext, node: AnyNode) {
  return (
    classifyExecutionEvidence(ctx, node) === "unknown" &&
    !ctx.project.nuxt?.manifest?.evidence?.buildManifest
  );
}

export function isTopLevelVueScriptSetupCall(ctx: RuleContext, node: AnyNode) {
  if (!ctx.file.relativePath.endsWith(".vue") || !/<script\b[^>]*\bsetup\b/.test(ctx.file.text))
    return false;
  return nearestFunctionOrProgram(node)?.type === "Program";
}

export function isLikelyRenderedTimeExpression(ctx: RuleContext, node: AnyNode) {
  const text = ctx.file.text;
  if (/<\s*(NuxtTime|ClientOnly)\b/.test(text)) return false;
  if (ctx.helpers.isClientOnlyExecutionContext(node, text)) return false;
  const source = sourceForNode(node, text);
  if (!source) return false;
  const template = getTemplateSource(ctx);
  if (template.includes(source)) return true;

  const declarator = nearestVariableDeclarator(node);
  const name = declarator?.id?.type === "Identifier" ? declarator.id.name : "";
  if (!name) return false;
  if (getTemplateBoundIdentifiers(ctx).has(name)) return true;
  if (new RegExp(`{{[^}]*\\b${escapeRegExp(name)}\\b[^}]*}}`).test(template)) return true;
  return isHydratingStateValue(node);
}

export function isInsideExportedFunction(text: string, offset: number) {
  const before = text.slice(Math.max(0, offset - 260), offset);
  return /export\s+(async\s+)?function\s+use[A-Z]\w+|export\s+const\s+use[A-Z]\w+\s*=/.test(before);
}

function computeExecutionEvidence(ctx: RuleContext, node: AnyNode): NuxtExecutionEvidence {
  if (
    isClientOnlyPath(ctx.file.relativePath) ||
    ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)
  )
    return "client-only";
  if (ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return "server-only";
  if (isCallFlowClientCallable(ctx, node)) return "event-handler";
  if (isReturnedCommandCallback(node)) return "returned-command";
  if (
    isTemplateBoundFunction(ctx, node) ||
    ctx.helpers.isLikelyEventHandler(ctx.file.text, node.start ?? 0)
  )
    return "event-handler";
  if (isLifecycleOrWatcherCallback(node)) return "lifecycle-only";
  return nearestFunctionOrProgram(node)?.type === "Program" ? "setup-time" : "unknown";
}

function getEvidenceCache(ctx: RuleContext): WeakMap<AnyNode, NuxtExecutionEvidence> {
  const key = `nuxt:evidence:${ctx.file.hash}`;
  let cache = ctx.cache.get<WeakMap<AnyNode, NuxtExecutionEvidence>>(key);
  if (!cache) {
    cache = new WeakMap();
    ctx.cache.set(key, cache);
  }
  return cache;
}

function getTemplateSource(ctx: RuleContext): string {
  const key = `nuxt:template:${ctx.file.hash}`;
  const cached = ctx.cache.get<string>(key);
  if (cached !== undefined) return cached;
  const value = ctx.file.text.match(TEMPLATE_BLOCK_RE)?.[1] ?? "";
  ctx.cache.set(key, value);
  return value;
}

function getTemplateBoundIdentifiers(ctx: RuleContext): Set<string> {
  const key = `nuxt:template-refs:${ctx.file.hash}`;
  const cached = ctx.cache.get<Set<string>>(key);
  if (cached) return cached;
  const set = new Set<string>();
  for (const match of getTemplateSource(ctx).matchAll(TEMPLATE_DIRECTIVE_RE_G)) {
    for (const id of (match[1] ?? "").matchAll(IDENT_RE_G)) set.add(id[0]);
  }
  ctx.cache.set(key, set);
  return set;
}

function isCallFlowClientCallable(ctx: RuleContext, node: AnyNode) {
  const flow = getCallFlowEvidence(ctx);
  return (
    findAncestor(node, (current) => {
      const name = namedFunctionForNode(current);
      return Boolean(name && flow.clientCallable.has(name));
    }) !== null
  );
}

function getCallFlowEvidence(ctx: RuleContext) {
  const key = `nuxt:call-flow:${ctx.file.hash}`;
  const cached = ctx.cache.get<{ clientCallable: Set<string> }>(key);
  if (cached) return cached;
  const graph = buildCallFlowEvidence(ctx);
  ctx.cache.set(key, graph);
  return graph;
}

function buildCallFlowEvidence(ctx: RuleContext) {
  const functions = new Map<string, AnyNode>();
  const calls = new Map<string, Set<string>>();
  const clientCallable = new Set<string>();

  walkScriptLocal(ctx.file.scriptAst, (node) => {
    const declared = functionDeclarationName(node);
    if (declared) functions.set(declared.name, declared.node);
  });

  for (const [name, node] of functions) {
    const directCalls = collectDirectCalledFunctionNames(node, functions);
    if (directCalls.size) calls.set(name, directCalls);
  }

  for (const match of getTemplateSource(ctx).matchAll(TEMPLATE_EVENT_RE_G)) {
    const name = match[1]?.match(IDENT_RE_G)?.[0];
    if (name && functions.has(name)) clientCallable.add(name);
  }

  walkScriptLocal(ctx.file.scriptAst, (node) => {
    if (node.type === "CallExpression") {
      const callee = ctx.helpers.getCalleeName(node);
      const owner = nearestNamedFunction(node);
      if (owner) {
        const called = calledFunctionName(node);
        if (called && functions.has(called)) {
          const ownerCalls = calls.get(owner) ?? new Set<string>();
          ownerCalls.add(called);
          calls.set(owner, ownerCalls);
        }
      }
      if (callee && CLIENT_CALLBACK_RE.test(callee)) {
        for (const arg of node.arguments ?? []) {
          const name = callbackArgumentName(arg);
          if (name && functions.has(name)) clientCallable.add(name);
        }
      }
      if (callee && CLIENT_LIFECYCLE_RE.test(callee)) {
        for (const arg of node.arguments ?? []) {
          const name = callbackArgumentName(arg);
          if (name && functions.has(name)) clientCallable.add(name);
          for (const called of collectDirectCalledFunctionNames(arg, functions)) {
            clientCallable.add(called);
          }
        }
      }
      return;
    }
    if (node.type === "Property") collectCommandPropertyName(node, functions, clientCallable);
    if (node.type === "ReturnStatement")
      collectReturnedCommandNames(node.argument, functions, clientCallable);
  });

  const queue = [...clientCallable];
  while (queue.length) {
    const name = queue.shift()!;
    for (const called of calls.get(name) ?? []) {
      if (!clientCallable.has(called)) {
        clientCallable.add(called);
        queue.push(called);
      }
    }
  }

  return { clientCallable };
}

function namedFunctionForNode(node: AnyNode) {
  if (node.type === "FunctionDeclaration" && node.id?.name) return node.id.name;
  const parent = node.__doctorParent ?? node.parent;
  if (
    ["FunctionExpression", "ArrowFunctionExpression"].includes(node.type) &&
    parent?.type === "VariableDeclarator" &&
    parent.id?.type === "Identifier"
  )
    return parent.id.name;
  if (
    ["FunctionExpression", "ArrowFunctionExpression"].includes(node.type) &&
    parent?.type === "Property"
  )
    return String(parent.key?.name ?? parent.key?.value ?? "");
  return null;
}

function functionDeclarationName(node: AnyNode): { name: string; node: AnyNode } | null {
  if (node.type === "FunctionDeclaration" && node.id?.name) return { name: node.id.name, node };
  if (
    node.type === "VariableDeclarator" &&
    node.id?.type === "Identifier" &&
    ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init?.type)
  )
    return { name: node.id.name, node: node.init };
  return null;
}

function calledFunctionName(node: AnyNode) {
  return node.callee?.type === "Identifier" ? node.callee.name : null;
}

function callbackArgumentName(node: AnyNode) {
  return node.type === "Identifier" ? node.name : null;
}

function collectDirectCalledFunctionNames(
  node: AnyNode,
  functions: Map<string, AnyNode>,
): Set<string> {
  const called = new Set<string>();
  const visit = (current: AnyNode, isRoot = false) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (
      !isRoot &&
      (current.type === "FunctionDeclaration" ||
        current.type === "FunctionExpression" ||
        current.type === "ArrowFunctionExpression")
    )
      return;
    if (current.type === "CallExpression") {
      const name = calledFunctionName(current);
      if (name && functions.has(name)) called.add(name);
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === "__doctorParent" || key === "parent") continue;
      visit(value);
    }
  };
  visit(node, true);
  return called;
}

function collectReturnedCommandNames(
  node: AnyNode,
  functions: Map<string, AnyNode>,
  clientCallable: Set<string>,
) {
  if (!node || node.type !== "ObjectExpression") return;
  for (const property of node.properties ?? []) {
    const key = String(property.key?.name ?? property.key?.value ?? "");
    const value = property.value ?? property.argument;
    if (!isCommandLikeName(key) && !isCommandLikeName(String(value?.name ?? ""))) continue;
    if (value?.type === "Identifier" && functions.has(value.name)) clientCallable.add(value.name);
    if (["FunctionExpression", "ArrowFunctionExpression"].includes(value?.type) && key)
      clientCallable.add(key);
  }
}

function collectCommandPropertyName(
  property: AnyNode,
  functions: Map<string, AnyNode>,
  clientCallable: Set<string>,
) {
  const key = String(property.key?.name ?? property.key?.value ?? "");
  if (!isCommandLikeName(key)) return;
  const value = property.value ?? property.argument;
  if (value?.type === "Identifier" && functions.has(value.name)) clientCallable.add(value.name);
}

function isReturnedCommandCallback(node: AnyNode) {
  const fn = nearestFunctionOrProgram(node);
  if (!fn) return false;
  return (
    findAncestor(
      fn,
      (parent) =>
        (parent.type === "Property" &&
          isCommandLikeName(String(parent.key?.name ?? parent.key?.value ?? ""))) ||
        parent.type === "ReturnStatement",
    ) !== null
  );
}

function isTemplateBoundFunction(ctx: RuleContext, node: AnyNode) {
  const fn = nearestNamedFunction(node);
  return Boolean(fn && getTemplateBoundIdentifiers(ctx).has(fn));
}

function nearestNamedFunction(node: AnyNode): string | null {
  const found = findAncestor(
    node,
    (current) =>
      (current.type === "FunctionDeclaration" && current.id?.name) ||
      (current.type === "VariableDeclarator" && current.id?.type === "Identifier"),
  );
  return found?.id?.name ?? null;
}

function isLifecycleOrWatcherCallback(node: AnyNode) {
  const fn = nearestFunctionOrProgram(node);
  if (!fn) return false;
  return (
    findAncestor(fn, (parent) => {
      if (parent.type !== "CallExpression") return false;
      const name = parent.callee?.name ?? parent.callee?.property?.name;
      return LIFECYCLE_RE.test(name ?? "");
    }) !== null
  );
}

function isCommandLikeName(name: string) {
  return COMMAND_LIKE_RE.test(name);
}

function nearestVariableDeclarator(node: AnyNode) {
  let current = node.__doctorParent ?? node.parent;
  while (current) {
    if (current.type === "VariableDeclarator") return current;
    if (nearestFunctionOrProgram(current) === current) return null;
    current = current.__doctorParent ?? current.parent;
  }
  return null;
}

function isHydratingStateValue(node: AnyNode) {
  return (
    findAncestor(
      node,
      (current) =>
        current.type === "CallExpression" &&
        (current.callee?.name === "useState" || current.callee?.name === "useAsyncData"),
    ) !== null
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
