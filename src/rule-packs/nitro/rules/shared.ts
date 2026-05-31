import { createRule, type RuleContext } from "../../../core/index.js";
import type { AnyNode } from "../../../core/rule-authoring.js";
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
  suggestion?: string,
) {
  const code = diagnosticCodesByRuleId[ruleId];
  const diagnostic = diagnostics[code];
  if (!diagnostic) throw new Error(`Missing Doctor diagnostic code for ${ruleId}`);
  ctx.helpers.report(ctx, node, diagnostic({ why: message, fix: suggestion ?? message }), {
    ruleId,
    severity,
    category,
  });
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
