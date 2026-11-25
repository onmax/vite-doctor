import { removedH3Types, removedH3Values } from "./_h3-v1-exports.js";
import {
  type AnyNode,
  createRule,
  h3ExportName,
  h3ImportBindings,
  isH3Source,
  report,
} from "./shared.js";

const ruleId = "h3/migration/no-removed-exports";

export const noRemovedExports = createRule({
  meta: {
    id: ruleId,
    title: "Replace exports removed in H3 v2",
    description:
      "Flags imports and h3 namespace reads of the values and types H3 v2 removed, such as send(), sendError(), MIMES, and the App type.",
    why: "H3 v2 no longer exports these names. Importing a removed value fails when the module loads, and importing a removed type fails the typecheck.",
    recommendedReplacement:
      "Use the replacement the H3 migration guide names, such as returning the value instead of send() or throwing an HTTPError instead of sendError().",
    category: "migration",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/migration",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    const reportRemoved = (node: AnyNode, name: string) => {
      const isValue = removedH3Values.has(name);
      const replacement = isValue ? removedH3Values.get(name) : removedH3Types.get(name);
      report(
        ctx,
        node,
        ruleId,
        "error",
        "migration",
        isValue
          ? `H3 v2 removed the ${name} export.`
          : `H3 v2 removed the ${name} type, so importing it fails the typecheck.`,
        replacement ??
          (isValue
            ? `Remove the ${name} usage; H3 v2 has no replacement.`
            : `Remove the ${name} type or declare it locally; H3 v2 has no replacement.`),
      );
    };
    const isRemoved = (name: unknown): name is string =>
      typeof name === "string" && (removedH3Values.has(name) || removedH3Types.has(name));
    const checkSpecifiers = (node: AnyNode, nameOf: (specifier: AnyNode) => unknown) => {
      if (!isH3Source(node.source?.value)) return;
      for (const specifier of node.specifiers ?? []) {
        const name = nameOf(specifier);
        if (isRemoved(name)) reportRemoved(specifier, name);
      }
    };
    return {
      MemberExpression(node: AnyNode) {
        if (h3ImportBindings(ctx).namespaces.size === 0) return;
        const name = h3ExportName(ctx, node);
        if (name && removedH3Values.has(name)) reportRemoved(node, name);
      },
      // Type-only imports count too: a removed type breaks the typecheck the same way.
      ImportDeclaration(node: AnyNode) {
        checkSpecifiers(node, (specifier) =>
          specifier.type === "ImportSpecifier" ? exportedName(specifier.imported) : undefined,
        );
      },
      ExportNamedDeclaration(node: AnyNode) {
        checkSpecifiers(node, (specifier) => exportedName(specifier.local));
      },
    };
  },
});

function exportedName(node: AnyNode): string | undefined {
  return node?.name ?? (typeof node?.value === "string" ? node.value : undefined);
}
