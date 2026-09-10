import { createRule } from "../../../core/index.js";
import {
  isTypeAssertion,
  isConstAssertion,
  isTypeScriptSource,
  report,
  type AnyNode,
} from "./shared.js";
import { createLocalEvidence, expression } from "./local-evidence.js";

const ruleId = "typescript/evidence/no-widen-then-assert";

export const noWidenThenAssert = createRule({
  meta: {
    id: "typescript/evidence/no-widen-then-assert",
    title: "Keep known evidence through local assertions",
    description:
      "Detect immutable local values widened to a broad type and later asserted to a concrete type.",
    why: "Widening a known value before asserting a new type separates the unsupported claim from its evidence. This rule follows immutable local aliases within one function; imported types and cross-function flows are outside its analysis.",
    recommendedReplacement:
      "Preserve the original inferred type, or validate the value before claiming a different type.",
    examples: [
      {
        title: "Keep known evidence through local assertions",
        language: "ts",
        invalid:
          "const value = { id: 1 }; const erased: unknown = value; const user = erased as User",
        valid: "const value = { id: 1 }; const user = UserSchema.parse(value)",
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
    function widened(node: AnyNode, owner: AnyNode, seen = new Set<unknown>()): boolean {
      node = expression(node);
      const target = evidence.binding(node);
      if (
        !target ||
        target.kind !== "const" ||
        target.written ||
        target.owner !== owner ||
        seen.has(target) ||
        target.node.start >= node.start
      )
        return false;
      seen.add(target);
      let initial = expression(target.init);
      if (evidence.broadType(target.annotation)) return evidence.known(initial, owner);
      if (target.annotation) return false;
      if (isTypeAssertion(initial) && evidence.broadType(initial.typeAnnotation))
        return evidence.known(initial.expression, owner);
      return widened(initial, owner, seen);
    }
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") {
          evidence = createLocalEvidence(node);
          return;
        }
        if (
          !isTypeAssertion(node) ||
          isConstAssertion(node) ||
          evidence.broadType(node.typeAnnotation)
        )
          return;
        if (!widened(node.expression, evidence.owner(node))) return;
        report(
          ctx,
          node,
          ruleId,
          "This assertion claims a concrete type after an immutable local value discarded known type evidence.",
          "Preserve the original type, or validate the value before asserting a different contract.",
        );
      },
    };
  },
});
