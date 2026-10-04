import {
  codeForRuleId,
  createRule,
  diagnosticForCode,
  type RuleContext,
} from "../../../core/index.js";
import type { AnyNode } from "../../../core/rule-authoring.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { diagnosticCodesByRuleId, diagnostics } from "../diagnostics.js";

export { createRule };
export {
  nearestFunctionOrProgram,
  sourceForNode,
  walkScriptLocal,
  type AnyNode,
} from "../../../core/rule-authoring.js";

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

export function isObjectPropertyKey(node: AnyNode) {
  const parent = node.parent ?? node.__doctorParent;
  if (
    parent?.type === "Property" &&
    (parent.key === node || parent.value === node) &&
    !parent.computed
  ) {
    const container = parent.parent ?? parent.__doctorParent;
    if (parent.shorthand && container?.type === "ObjectPattern") return true;
    return parent.key === node && !parent.shorthand;
  }
  return (
    (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
    (parent?.type === "StaticMemberExpression" && parent.property === node)
  );
}

export function isNitroRouteFile(ctx: RuleContext) {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  if (ctx.project.framework === "nuxt")
    return /^(?:app\/)?server\/(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path);
  return (
    ctx.project.framework === "nitro" && /^(?:server\/)?(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path)
  );
}

export function isNitroServerFile(ctx: RuleContext) {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  return (
    (ctx.project.framework === "nuxt" && ctx.helpers.isNuxtServerFile(path)) ||
    (ctx.project.framework === "nitro" &&
      (path.startsWith("server/") ||
        isNitroRouteFile(ctx) ||
        /^middleware\/.+\.[cm]?[jt]s$/.test(path)))
  );
}
