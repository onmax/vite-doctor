import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, report, type AnyNode } from "./shared.js";
import { createLocalEvidence, expression } from "./local-evidence.js";

const ruleId = "typescript/evidence/no-known-value-widening";

export const noKnownValueWidening = createRule({
  meta: {
    id: "typescript/evidence/no-known-value-widening",
    title: "Preserve known values in local declarations",
    description: "Detect local annotations that discard known values or object keys.",
    why: "Broad annotations can discard useful evidence from an initializer. This rule checks local variable annotations with direct syntax evidence and open Record annotations on nonempty object literals. It allows empty dictionary accumulators and finite-key Records; it does not infer imported types, calls, or generic aliases.",
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
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") {
          evidence = createLocalEvidence(node);
          return;
        }
        if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier" || !node.init)
          return;
        const annotation = node.id.typeAnnotation?.typeAnnotation;
        if (!annotation) return;
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
        report(
          ctx,
          annotation,
          ruleId,
          "This annotation discards known value or property evidence from the initializer.",
          "Keep the inferred type, or replace the annotation with satisfies to validate the contract without widening the value.",
        );
      },
    };
  },
});
