import { AnyNode, createRule, report } from "./shared.js";
import { isAstNode } from "../../../../core/internal/ast-node.js";
import { isString } from "../../../../core/internal/value-schema.js";

const UNTRUSTED_IDENTIFIERS = new Set(["route", "params", "query", "user", "content", "markdown"]);

export const preferUseHeadSafeForUntrustedValues = createRule({
  meta: {
    id: "nuxt/security/prefer-useheadsafe-for-untrusted-values",
    title: "Use useHeadSafe for untrusted head values",
    category: "security",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-head-safe#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        if (!hasUntrustedHeadValue(node.arguments?.[0])) return;
        report(
          ctx,
          node,
          "nuxt/security/prefer-useheadsafe-for-untrusted-values",
          "warn",
          "security",
          "Head values derived from route, content, or user data should be constrained.",
          "Use useHeadSafe() or sanitize the value before passing it to useHead().",
        );
      },
    };
  },
});

function hasUntrustedHeadValue(node: AnyNode): boolean {
  if (Array.isArray(node)) return node.some(hasUntrustedHeadValue);
  if (!isAstNode(node)) return false;
  if (node.type === "Identifier" && isString(node.name) && UNTRUSTED_IDENTIFIERS.has(node.name))
    return true;
  if (
    (node.type === "MemberExpression" || node.type === "StaticMemberExpression") &&
    isAstNode(node.object) &&
    node.object.type === "Identifier" &&
    isString(node.object.name) &&
    UNTRUSTED_IDENTIFIERS.has(node.object.name)
  )
    return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    if (node.type === "Property" && key === "key" && !node.computed) continue;
    if (
      (node.type === "MemberExpression" || node.type === "StaticMemberExpression") &&
      key === "property" &&
      !node.computed
    )
      continue;
    if (hasUntrustedHeadValue(value)) return true;
  }
  return false;
}
