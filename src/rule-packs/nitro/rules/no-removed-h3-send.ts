import { parseForESLint } from "../../../core/internal/lazy-parsers.js";
import type { RuleContext } from "../../../core/index.js";
import { createVueScriptForParsing } from "../../../core/internal/sfc.js";
import { type AnyNode, createRule, report } from "./shared.js";

export const noRemovedH3Send = createRule({
  meta: {
    id: "nitro/h3/no-removed-send",
    title: "Replace removed H3 send utilities",
    description:
      "H3 v2 removes send() and sendError() in favor of returned values and thrown errors.",
    why: "H3 v2 handlers use Web API response values and HTTPError instead of imperative send helpers.",
    recommendedReplacement:
      "Return the response value from the handler, or throw an HTTPError for an error response.",
    category: "migration",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/migration",
    requires: { script: true, nitro: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    let namespaceReads: Map<number, string> | undefined;
    const reportRemoved = (node: AnyNode, imported: string) =>
      report(
        ctx,
        node,
        "nitro/h3/no-removed-send",
        "error",
        "migration",
        `H3 v2 removes ${imported}().`,
        imported === "send"
          ? "Return the response value from the handler."
          : "Throw an HTTPError from the handler.",
      );
    return {
      MemberExpression(node: AnyNode) {
        const imported = (namespaceReads ??= removedNamespaceReads(ctx)).get(node.start);
        if (imported) reportRemoved(node, imported);
      },
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "h3" && node.source?.value !== "nitro/h3") return;
        for (const specifier of node.specifiers ?? []) {
          const imported = specifier.imported?.name;
          if (imported !== "send" && imported !== "sendError") continue;
          reportRemoved(specifier, imported);
        }
      },
    };
  },
});

function removedNamespaceReads(ctx: RuleContext): Map<number, string> {
  const result = new Map<number, string>();
  const script = ctx.file.sfc
    ? createVueScriptForParsing(ctx.file.sfc.descriptor, ctx.file.text)
    : { text: ctx.file.text, lang: /\.[jt]sx$/.test(ctx.file.relativePath) ? "tsx" : "ts" };
  try {
    const { ast, scopeManager, visitorKeys } = parseForESLint(script.text, {
      range: true,
      sourceType: "module",
      ecmaFeatures: { jsx: ["jsx", "tsx"].includes(script.lang) },
    });
    const references = new Map(
      scopeManager.scopes.flatMap((scope) =>
        scope.references.map((reference) => [reference.identifier, reference] as const),
      ),
    );
    const visit = (node: AnyNode) => {
      if (!node?.type) return;
      if (node.type === "MemberExpression" && node.object.type === "Identifier") {
        const property = node.computed
          ? node.property.type === "TemplateLiteral" && node.property.expressions.length === 0
            ? node.property.quasis[0]?.value.cooked
            : node.property.value
          : node.property.name;
        if (property === "send" || property === "sendError") {
          const variable = references.get(node.object)?.resolved;
          if (
            variable?.defs.some(
              (definition) =>
                definition.type === "ImportBinding" &&
                definition.node.type === "ImportNamespaceSpecifier" &&
                definition.parent.type === "ImportDeclaration" &&
                definition.parent.importKind !== "type" &&
                ["h3", "nitro/h3"].includes(String(definition.parent.source.value)),
            )
          )
            result.set(node.range[0], property);
        }
      }
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
