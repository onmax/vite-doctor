import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, report, type AnyNode } from "./shared.js";
import { createLocalEvidence, expression } from "./local-evidence.js";

const ruleId = "typescript/evidence/no-known-value-widening";

export const noKnownValueWidening = createRule({
  meta: {
    id: "typescript/evidence/no-known-value-widening",
    title: "Preserve known values in local declarations",
    description: "Detect local annotations that discard known values or object keys.",
    why: "Broad annotations can discard useful evidence from an initializer. This rule checks local variable annotations with direct syntax evidence and open Record annotations on nonempty object literals. It allows empty dictionary accumulators, finite-key Records, and bindings that rely on the declared type: exported or `let` bindings, member writes or deletes, and reads with a runtime or undeclared key. It does not infer imported types, calls, or generic aliases.",
    recommendedReplacement:
      "Keep inference, or use satisfies to check a contract while preserving the inferred type.",
    examples: [
      {
        title: "Preserve known values in local declarations",
        language: "ts",
        invalid: "const handlers: Record<string, Handler> = { start: startHandler }",
        valid: "const handlers = { start: startHandler } satisfies Record<string, Handler>",
      },
    ],
    category: "evidence",
    severity: "warn",
    fixable: "structural-review",
    docsUrl:
      "https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b#rules",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    if (!isTypeScriptSource(ctx)) return;
    let evidence: ReturnType<typeof createLocalEvidence>;
    const template =
      ((ctx.sfc ?? ctx.file.sfc)?.descriptor as { template?: { content?: string } } | undefined)
        ?.template?.content ?? "";
    // A binding that is exported, written, or indexed by a runtime or undeclared key relies on
    // its declared type: `satisfies` would reject `table[key]` and `table.extra = …`. Template
    // expressions are outside the script AST, so a binding the template names is not checked.
    function usedAsInferred(id: AnyNode, initial: AnyNode): boolean {
      const name = id.name.replaceAll("$", "\\$");
      if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(template)) return false;
      const keys = declaredKeys(initial);
      return evidence.references(id).every((reference) => {
        let value = reference;
        let parent = evidence.parent(value);
        while (parent && expression(parent) === reference) {
          value = parent;
          parent = evidence.parent(value);
        }
        if (
          (parent?.type === "VariableDeclarator" &&
            parent.init === value &&
            parent.id.type !== "Identifier") ||
          (parent?.type === "AssignmentExpression" &&
            parent.right === value &&
            ["ObjectPattern", "ArrayPattern"].includes(parent.left.type)) ||
          (parent?.type === "AssignmentPattern" && parent.right === value)
        )
          return false;
        if (["ExportSpecifier", "ExportDefaultDeclaration"].includes(parent?.type)) return false;
        if (!["MemberExpression", "StaticMemberExpression"].includes(parent?.type)) return true;
        if (parent.object !== value) return true;
        const target = evidence.parent(parent);
        if (
          evidence.written(parent) ||
          (target?.type === "UnaryExpression" && target.operator === "delete")
        )
          return false;
        const key = parent.computed
          ? parent.property?.type === "Literal" &&
            ["string", "number"].includes(typeof parent.property.value)
            ? String(parent.property.value)
            : undefined
          : parent.property?.name;
        return key !== undefined && !!keys?.has(key);
      });
    }
    return {
      Program(node: AnyNode) {
        evidence = createLocalEvidence(node);
      },
      VariableDeclarator(node: AnyNode) {
        if (node.id?.type !== "Identifier" || !node.init) return;
        const annotation = node.id.typeAnnotation?.typeAnnotation;
        if (!annotation) return;
        const declaration = evidence.parent(node);
        if (
          declaration?.kind !== "const" ||
          evidence.parent(declaration)?.type === "ExportNamedDeclaration"
        )
          return;
        const initial = expression(node.init, true);
        if (initial?.type === "ObjectExpression" && !initial.properties.length) return;
        const losesKeys =
          evidence.globalType(annotation, "Record") &&
          ["TSStringKeyword", "TSNumberKeyword", "TSSymbolKeyword"].includes(
            annotation.typeArguments?.params?.[0]?.type,
          ) &&
          initial?.type === "ObjectExpression" &&
          initial.properties.some(
            (property: AnyNode) => property.type === "Property" && !property.computed,
          );
        if (!losesKeys && !(evidence.broadType(annotation) && evidence.known(initial))) return;
        if (!usedAsInferred(node.id, initial)) return;
        report(
          ctx,
          annotation,
          ruleId,
          "This annotation discards known value or property evidence from the initializer, and every use of the binding works with the inferred type.",
          "Remove the annotation, or move it after the initializer as `satisfies` (for example `const table = { key: value } satisfies Record<string, Value>`). The binding is only read by declared keys or passed whole, so either edit type-checks.",
        );
      },
    };
  },
});

function declaredKeys(initial: AnyNode): Set<string> | undefined {
  if (initial?.type !== "ObjectExpression") return;
  const keys = new Set<string>();
  for (const property of initial.properties) {
    if (property.type !== "Property" || property.computed) return;
    if (property.key?.type === "Identifier") keys.add(property.key.name);
    else if (property.key?.type === "Literal") keys.add(String(property.key.value));
    else return;
  }
  return keys;
}
