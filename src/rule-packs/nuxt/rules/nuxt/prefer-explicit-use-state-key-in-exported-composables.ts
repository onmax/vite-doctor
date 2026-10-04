import { parseForESLint } from "@typescript-eslint/parser";
import { AnyNode, createRule, isInsideExportedFunction, report } from "./shared.js";

export const preferExplicitUseStateKeyInExportedComposables = createRule({
  meta: {
    id: "nuxt/state/prefer-explicit-usestate-key-in-exported-composables",
    title: "Use explicit useState keys in exported composables",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-state#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/(^|\/)(composables|utils|shared)\//.test(ctx.file.relativePath)) return;
    let constantKeys: Set<number> | undefined;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useState")) return;
        if (typeof node.arguments?.[0]?.value === "string") return;
        if (
          (constantKeys ??= constantStringKeys(ctx.file.text, ctx.file.relativePath)).has(
            node.arguments?.[0]?.start,
          )
        )
          return;
        if (!isInsideExportedFunction(ctx.file.text, node.start)) return;
        report(
          ctx,
          node,
          "nuxt/state/prefer-explicit-usestate-key-in-exported-composables",
          "warn",
          "hydration",
          "Exported composables should not rely on generated useState keys because callsite location can change.",
          "Pass an explicit stable key as the first useState() argument.",
        );
      },
    };
  },
});

function constantStringKeys(source: string, path: string): Set<number> {
  const result = new Set<number>();
  try {
    const { ast, scopeManager, visitorKeys } = parseForESLint(source, {
      range: true,
      sourceType: "module",
      ecmaFeatures: { jsx: /\.[jt]sx$/.test(path) },
    });
    const references = new Map(
      scopeManager.scopes.flatMap((scope) =>
        scope.references.map((reference) => [reference.identifier, reference] as const),
      ),
    );
    const resolve = (node: AnyNode, seen = new Set<unknown>()): string | undefined => {
      if (!node) return;
      if (node.type === "Literal" && typeof node.value === "string") return node.value;
      if (node.type === "TemplateLiteral" && node.expressions.length === 0)
        return node.quasis[0]?.value.cooked ?? undefined;
      if (
        [
          "TSAsExpression",
          "TSTypeAssertion",
          "TSSatisfiesExpression",
          "TSNonNullExpression",
        ].includes(node.type)
      )
        return resolve(node.expression, seen);
      if (node.type === "BinaryExpression" && node.operator === "+") {
        const left = resolve(node.left, seen);
        const right = resolve(node.right, seen);
        if (left !== undefined && right !== undefined) return left + right;
      }
      if (node.type !== "Identifier") return;
      const variable = references.get(node)?.resolved;
      if (!variable || seen.has(variable)) return;
      for (const definition of variable.defs) {
        if (
          definition.type !== "Variable" ||
          definition.parent.kind !== "const" ||
          definition.node.id.type !== "Identifier"
        )
          continue;
        return resolve(definition.node.init, new Set([...seen, variable]));
      }
    };
    const visit = (node: AnyNode) => {
      if (!node?.type) return;
      if (node.type === "CallExpression" && resolve(node.arguments[0]) !== undefined)
        result.add(node.arguments[0].range[0]);
      for (const key of visitorKeys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
    };
    visit(ast);
  } catch {
    return result;
  }
  return result;
}
