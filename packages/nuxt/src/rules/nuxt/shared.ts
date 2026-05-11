import { relative } from "pathe";
import { createRule, type RuleContext } from "@vue-doctor/core";

export { createRule };

export type AnyNode = any;

export const NUXT_AUTO_IMPORTS = new Set([
  "useFetch",
  "useAsyncData",
  "useRoute",
  "useRouter",
  "useRuntimeConfig",
  "useNuxtApp",
  "navigateTo",
  "definePageMeta",
  "defineNuxtRouteMiddleware",
  "useState",
]);
export const BROWSER_SIDE_EFFECTS = new Set([
  "localStorage.setItem",
  "sessionStorage.setItem",
  "document.write",
  "document.title",
]);
export const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "ResizeObserver",
  "IntersectionObserver",
]);
export const NUXT_APP_DIRS = new Set([
  "assets",
  "components",
  "composables",
  "layouts",
  "middleware",
  "pages",
  "plugins",
  "utils",
]);

export type NuxtFileClass =
  | "runtime-app"
  | "server-runtime"
  | "config-build"
  | "content-docs"
  | "generated"
  | "external-package"
  | "unknown";

export type NuxtExecutionEvidence =
  | "setup-time"
  | "event-handler"
  | "returned-command"
  | "lifecycle-only"
  | "client-only"
  | "server-only"
  | "unknown";

const FN_OR_PROG_TYPES = new Set([
  "Program",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const TEMPLATE_BLOCK_RE = /<template[^>]*>([\s\S]*?)<\/template>/;
const TEMPLATE_DIRECTIVE_RE_G = /[@:]\w+(?:\.[\w.]+)?\s*=\s*["']([^"']+)["']/g;
const TEMPLATE_EVENT_RE_G = /@\w+(?:\.[\w.]+)?\s*=\s*["']([^"']+)["']/g;
const IDENT_RE_G = /\b[A-Za-z_$][\w$]*\b/g;
const CLIENT_CALLBACK_RE =
  /^(useEventListener|addEventListener|onKeyDown|onKeyUp|onKeyStroke|onClickOutside|onLongPress|usePointerSwipe|useSwipe|useIntersectionObserver|useResizeObserver|useMutationObserver|defineShortcuts)$/;
const LIFECYCLE_RE =
  /^(onMounted|onBeforeMount|onUnmounted|watch|watchEffect|watchPostEffect|nextTick)$/;
const COMMAND_LIKE_RE =
  /^(on[A-Z]|handle|handler|callback|execute|run|open|close|toggle|submit|select|copy|download|navigate|scroll)/;

export function findAncestor(node: AnyNode, predicate: (current: AnyNode) => boolean) {
  let current = node?.__doctorParent ?? node?.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.__doctorParent ?? current.parent;
  }
  return null;
}

export function report(
  ctx: RuleContext,
  node: AnyNode,
  ruleId: string,
  severity: any,
  category: string,
  message: string,
  suggestion?: string,
) {
  ctx.helpers.report(ctx, node, {
    ruleId,
    severity,
    category,
    message,
    suggestion,
  });
}

export function hasPriorAwaitInSameExecutionScope(node: AnyNode): boolean {
  const scope = nearestFunctionOrProgram(node);
  if (!scope) return false;
  let seenTarget = false;
  let seenAwait = false;
  walkScriptLocal(scope.body ?? scope, (current) => {
    if (current === node) {
      seenTarget = true;
      return;
    }
    if (!seenTarget && current.type === "AwaitExpression") seenAwait = true;
  });
  return seenAwait;
}

export function nearestFunctionOrProgram(node: AnyNode): AnyNode {
  let current = node;
  while (current) {
    if (FN_OR_PROG_TYPES.has(current.type)) return current;
    current = current.__doctorParent;
  }
  return null;
}

export function walkScriptLocal(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkScriptLocal(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkScriptLocal(child, visit);
    } else if (value && typeof value === "object") {
      walkScriptLocal(value, visit);
    }
  }
}

export function includeTrailingNewline(text: string, end: number) {
  return text[end] === "\r" && text[end + 1] === "\n"
    ? end + 2
    : text[end] === "\n"
      ? end + 1
      : end;
}

export function isClientOnlyPath(path: string) {
  return /\.client\.[cm]?[jt]sx?$/.test(path) || path.includes(".client.vue");
}

export function classifyNuxtFile(ctx: RuleContext): NuxtFileClass {
  const relativePath = toPosixPath(ctx.file.relativePath);
  if (isGeneratedFile(ctx)) return "generated";
  if (isContentDocsPath(relativePath, ctx.file.sourceKind)) return "content-docs";
  if (isConfigBuildPath(relativePath)) return "config-build";
  if (ctx.helpers.isNuxtServerFile(relativePath)) return "server-runtime";
  if (isRuntimeAppPath(ctx, relativePath)) return "runtime-app";
  if (isExternalPackagePath(relativePath)) return "external-package";
  return "unknown";
}

export function isGeneratedFile(ctx: RuleContext) {
  const relativePath = toPosixPath(ctx.file.relativePath);
  if (
    relativePath.startsWith("shared/types/lexicons/") ||
    relativePath.startsWith("app/generated/") ||
    relativePath.startsWith("generated/")
  )
    return true;
  return /@generated|generated by|do not edit|auto-generated/i.test(ctx.file.text.slice(0, 800));
}

export function isRuntimeAppFile(ctx: RuleContext) {
  return classifyNuxtFile(ctx) === "runtime-app";
}

export function isServerRuntimeFile(ctx: RuleContext) {
  return classifyNuxtFile(ctx) === "server-runtime";
}

export function isContentDocsFile(ctx: RuleContext) {
  return classifyNuxtFile(ctx) === "content-docs";
}

export function isConfigBuildFile(ctx: RuleContext) {
  return classifyNuxtFile(ctx) === "config-build";
}

export function isNuxtRuntimeFile(ctx: any) {
  return isRuntimeAppFile(ctx);
}

function isRuntimeAppPath(ctx: RuleContext, relativePath: string) {
  if (ctx.file.sourceKind === "module") return false;
  const roots = ctx.project.nuxt?.appRoots;
  if (roots?.length) {
    const relativeRoots = roots
      .map((root: string) => toPosixPath(relative(ctx.project.root, root)))
      .filter((root: string) => root && root !== ".");
    if (relativeRoots.length) {
      return relativeRoots.some(
        (root: string) => relativePath === root || relativePath.startsWith(`${root}/`),
      );
    }
  }

  if (relativePath.startsWith("app/")) return true;
  const [first] = relativePath.split("/");
  return !!first && NUXT_APP_DIRS.has(first);
}

function isContentDocsPath(relativePath: string, sourceKind: string | undefined) {
  return (
    sourceKind === "content" ||
    /\.(md|mdc|markdown)$/.test(relativePath) ||
    relativePath.startsWith("content/")
  );
}

function isConfigBuildPath(relativePath: string) {
  return (
    /(^|\/)(nuxt|content|vite|vitest|eslint|tailwind|uno|app)\.config\.[cm]?[jt]s$/.test(
      relativePath,
    ) ||
    /(^|\/)package\.json$/.test(relativePath) ||
    /^(config|scripts|tools|test|tests|\.github)\//.test(relativePath)
  );
}

function isExternalPackagePath(relativePath: string) {
  return /^(cli|packages|connector|docs)\//.test(relativePath);
}

export function toPosixPath(path: string) {
  return path.replace(/\\/g, "/");
}

export function isObjectPropertyKey(node: AnyNode) {
  const parent = node.parent ?? node.__doctorParent;
  return (
    (parent?.type === "Property" &&
      ((parent.key === node && !parent.computed) || parent.shorthand)) ||
    (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
    (parent?.type === "StaticMemberExpression" && parent.property === node)
  );
}

export function isKnownGuardedBrowserGlobal(text: string, offset: number) {
  const before = text.slice(Math.max(0, offset - 80), offset);
  return /import\.meta\.client|process\.client|typeof\s+(window|document|localStorage|sessionStorage|navigator)\s*!==?\s*["']undefined["']/.test(
    before,
  );
}

export function hasPriorServerReturnGuard(text: string, offset: number) {
  const before = text.slice(Math.max(0, offset - 500), offset);
  return /if\s*\(\s*import\.meta\.server\s*\)\s*(?:\{\s*)?return\b/s.test(before);
}

export function isVueUseBrowserGlobalTarget(node: AnyNode) {
  const parent = node.__doctorParent ?? node.parent;
  if (!parent || parent.type !== "CallExpression") return false;
  if (!parent.arguments?.includes(node)) return false;
  const callee = parent.callee?.name;
  return (
    callee === "useEventListener" ||
    callee === "useScroll" ||
    callee === "useScrollLock" ||
    callee === "useElementBounding" ||
    callee === "useIntersectionObserver" ||
    callee === "useResizeObserver"
  );
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

export function replacementForBrowserGlobal(name: string) {
  if (name === "localStorage" || name === "sessionStorage")
    return "Use useCookie() for SSR-visible preference state, or read browser storage inside onMounted().";
  if (name === "window" || name === "document")
    return "Use <ClientOnly>, onMounted(), or a .client plugin for browser-only DOM work.";
  return "Guard this with import.meta.client or move it to client-only code.";
}

export function templateExpressions(node: AnyNode, source: string): string[] {
  const values: string[] = [];
  for (const attr of node.startTag?.attributes ?? []) {
    const expression = attr.value?.expression;
    if (expression?.start != null && expression?.end != null)
      values.push(String(expression.raw ?? source.slice(expression.start, expression.end)));
  }
  if (node.type === "VExpressionContainer" && node.expression)
    values.push(
      String(
        node.expression.raw ??
          (node.expression.start != null && node.expression.end != null
            ? source.slice(node.expression.start, node.expression.end)
            : ""),
      ),
    );
  const nodeSource = sourceForNode(node, source);
  if (nodeSource) values.push(nodeSource);
  return values;
}

export function sourceForNode(node: AnyNode, source: string) {
  const start = node.start ?? node.range?.[0];
  const end = node.end ?? node.range?.[1];
  return typeof start === "number" && typeof end === "number" ? source.slice(start, end) : "";
}

export function getElementName(node: AnyNode) {
  return node.rawName ?? node.name;
}

export function getDirectiveExpression(
  node: AnyNode,
  name: string,
  argument: string,
  source: string,
) {
  const attr = (node.startTag?.attributes ?? []).find(
    (item: AnyNode) =>
      item.directive && item.key?.name?.name === name && item.key?.argument?.name === argument,
  );
  const expression = attr?.value?.expression;
  if (!expression) return null;
  const start = expression.start ?? expression.range?.[0];
  const end = expression.end ?? expression.range?.[1];
  return expression.raw ?? (start != null && end != null ? source.slice(start, end) : null);
}

export function getStaticAttr(node: AnyNode, name: string) {
  const attr = (node.startTag?.attributes ?? []).find(
    (item: AnyNode) => !item.directive && item.key?.name === name,
  );
  return attr?.value?.value ?? null;
}

export function simpleTagRenameFix(text: string, node: AnyNode, replacement: string) {
  const start = node.start;
  const end = node.end;
  if (typeof start !== "number" || typeof end !== "number") return null;
  const snippet = text.slice(start, end);
  const replaced = snippet
    .replaceAll("RouterView", replacement)
    .replaceAll("router-view", replacement);
  return {
    kind: "safe" as const,
    edits: [{ range: { start, end }, text: replaced }],
  };
}

export function isNewDate(node: AnyNode) {
  return node.type === "NewExpression" && node.callee?.name === "Date";
}

export function isStableKeyNode(node: AnyNode) {
  return node.type === "Literal" || node.type === "TemplateLiteral";
}

export function isObviouslyUnstableKeyNode(node: AnyNode, source: string) {
  const text = sourceForNode(node, source);
  return /(?:Math\.random|Date\.now|new\s+Date|randomUUID|crypto\.randomUUID)\s*\(/.test(text);
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

function nearestVariableDeclarator(node: AnyNode) {
  let current = node.__doctorParent ?? node.parent;
  while (current) {
    if (current.type === "VariableDeclarator") return current;
    if (FN_OR_PROG_TYPES.has(current.type)) return null;
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

export function isInsideExportedFunction(text: string, offset: number) {
  const before = text.slice(Math.max(0, offset - 260), offset);
  return /export\s+(async\s+)?function\s+use[A-Z]\w+|export\s+const\s+use[A-Z]\w+\s*=/.test(before);
}

export function isExplicitlyScannedByNuxt(ctx: RuleContext, kind: "imports" | "shared") {
  if (isGeneratedFile(ctx)) return true;
  const manifest = ctx.project.nuxt?.manifest;
  if (!manifest?.hasManifest) return false;
  const roots = kind === "imports" ? manifest.importsDirs : manifest.sharedScanRoots;
  const relativePath = toPosixPath(relative(ctx.project.root, ctx.file.path));
  return roots
    .map((root) => normalizeScanRoot(ctx, root))
    .filter(Boolean)
    .filter((root) =>
      kind === "imports" && !root.includes("*")
        ? root !== "app/composables" && root !== "composables"
        : root !== "shared/utils" && root !== "shared/types",
    )
    .some((root) => matchesScanRoot(relativePath, root));
}

function normalizeScanRoot(ctx: RuleContext, root: string) {
  let normalized = toPosixPath(root);
  const projectRoot = `${toPosixPath(ctx.project.root)}/`;
  if (normalized.startsWith(projectRoot)) normalized = normalized.slice(projectRoot.length);
  else normalized = toPosixPath(relative(ctx.project.root, normalized));
  normalized = normalized.replace(/^~\//, "app/").replace(/^@\//, "app/");
  return normalized.replace(/^\.\//, "");
}

function matchesScanRoot(relativePath: string, root: string) {
  if (root.includes("*")) return globToRegExp(root).test(relativePath);
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function globToRegExp(glob: string) {
  const pattern = glob
    .split("/")
    .map((part) =>
      part === "**" ? ".*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

export function isExplicitPlugin(ctx: RuleContext) {
  const manifest = ctx.project.nuxt?.manifest;
  if (!manifest?.hasManifest) return false;
  return manifest.pluginFiles.some((file) => resolveSameFile(file, ctx.file.path));
}

export function resolveSameFile(a: string, b: string) {
  return toPosixPath(a) === toPosixPath(b);
}
