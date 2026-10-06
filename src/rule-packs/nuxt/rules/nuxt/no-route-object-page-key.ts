import { parseForESLint } from "../../../../core/internal/lazy-parsers.js";
import { findTemplateDirective } from "../../../../core/rule-authoring.js";
import { AnyNode, createRule, report } from "./shared.js";

export const noRouteObjectPageKey = createRule({
  meta: {
    id: "nuxt/routing/no-route-object-page-key",
    title: "Do not use route objects as NuxtPage page keys",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      template: {
        element(node) {
          if (node.tag !== "NuxtPage") return;
          const pageKey = findTemplateDirective(node, "bind", "page-key")?.exp?.content.trim();
          if (!pageKey || !usesRouteObject(pageKey)) return;
          report(
            ctx,
            node,
            "nuxt/routing/no-route-object-page-key",
            "warn",
            "routing",
            "Using the route object as a NuxtPage page key can diverge from Nuxt's Suspense-backed page lifecycle.",
            "Use a stable string key derived from route params or explicit page metadata.",
          );
        },
      },
    };
  },
});

function usesRouteObject(source: string): boolean {
  try {
    const { ast, scopeManager, visitorKeys } = parseForESLint(`(${source})`, {
      range: true,
      sourceType: "module",
    });
    if (
      scopeManager.globalScope?.through.some((reference) =>
        ["route", "$route"].includes(reference.identifier.name),
      )
    )
      return true;
    const callback = (ast.body[0] as AnyNode)?.expression;
    if (!["ArrowFunctionExpression", "FunctionExpression"].includes(callback?.type)) return false;
    const parameter = callback.params[0];
    if (parameter?.type !== "Identifier") return false;
    const variable = scopeManager
      .acquire(callback, true)
      ?.variables.find((entry) => entry.identifiers.includes(parameter));
    const references = new Set(variable?.references.map((reference) => reference.identifier));
    const returnsParameter = (node: AnyNode): boolean => {
      if (!node) return false;
      if (node.type === "Identifier") return references.has(node);
      if (node.type === "ConditionalExpression")
        return returnsParameter(node.consequent) || returnsParameter(node.alternate);
      if (node.type === "LogicalExpression")
        return (
          (node.operator !== "&&" && returnsParameter(node.left)) || returnsParameter(node.right)
        );
      if (node.type === "SequenceExpression") return returnsParameter(node.expressions.at(-1));
      if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node.type))
        return returnsParameter(node.expression);
      return false;
    };
    const hasRouteReturn = (node: AnyNode): boolean => {
      if (
        !node ||
        ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
      )
        return false;
      if (node.type === "ReturnStatement") return returnsParameter(node.argument);
      return (visitorKeys[node.type] ?? []).some((key) => {
        const value = node[key];
        return Array.isArray(value) ? value.some(hasRouteReturn) : hasRouteReturn(value);
      });
    };
    return callback.body.type === "BlockStatement"
      ? hasRouteReturn(callback.body)
      : returnsParameter(callback.body);
  } catch {
    return false;
  }
}
