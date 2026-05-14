import { createRule, type RuleContext } from "@vue-doctor/core";
import { nearestFunctionOrProgram, sourceForNode, walkScriptLocal, type AnyNode } from "./ast.js";

export { createRule };
export { nearestFunctionOrProgram, sourceForNode, walkScriptLocal, type AnyNode } from "./ast.js";

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
  ctx.helpers.report(ctx, node, {
    ruleId,
    severity,
    category,
    message,
    suggestion,
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
