import { createRule, type RuleContext } from "@vue-doctor/core";
import { diagnosticCodesByRuleId, diagnostics } from "../../diagnostics.js";
import {
  nearestFunctionOrProgram,
  sourceForNode,
  walkScriptLocal,
  type AnyNode,
} from "../../../../core/src/rule-authoring.js";

export { createRule };
export {
  findAncestor,
  nearestFunctionOrProgram,
  sourceForNode,
  walkScriptLocal,
  type AnyNode,
} from "../../../../core/src/rule-authoring.js";
export {
  classifyNuxtFile,
  isConfigBuildFile,
  isContentDocsFile,
  isExplicitlyScannedByNuxt,
  isExplicitPlugin,
  isGeneratedFile,
  isNuxtRuntimeFile,
  isRuntimeAppFile,
  isServerRuntimeFile,
  resolveSameFile,
  toPosixPath,
  NUXT_APP_DIRS,
  type NuxtFileClass,
} from "./file-classification.js";
export {
  classifyExecutionEvidence,
  isClientCallableEvidence,
  isClientOnlyPath,
  isInsideExportedFunction,
  isLikelyRenderedTimeExpression,
  isPayloadSerializedEvidence,
  isReusableDataComposableContext,
  isSourceOnlyExecutionEvidence,
  isSsrExecutedEvidence,
  isTopLevelVueScriptSetupCall,
  type NuxtExecutionEvidence,
} from "./execution-evidence.js";

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
export function report(
  ctx: RuleContext,
  node: AnyNode,
  ruleId: string,
  severity: any,
  category: string,
  message: string,
  suggestion?: string,
) {
  const code = diagnosticCodesByRuleId[ruleId];
  const diagnostic = diagnostics[code];
  if (!diagnostic) throw new Error(`Missing Doctor diagnostic code for ${ruleId}`);
  ctx.helpers.report(ctx, node, diagnostic.report({ why: message, fix: suggestion ?? message }), {
    ruleId,
    severity,
    category,
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

export function includeTrailingNewline(text: string, end: number) {
  return text[end] === "\r" && text[end + 1] === "\n"
    ? end + 2
    : text[end] === "\n"
      ? end + 1
      : end;
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
