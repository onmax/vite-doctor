import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, report, type AnyNode } from "./shared.js";
import { arrayMethod, createLocalEvidence, expression } from "./local-evidence.js";

const ruleId = "typescript/performance/no-array-filter-map";

export const noArrayFilterMap = createRule({
  meta: {
    id: "typescript/performance/no-array-filter-map",
    title: "Review adjacent eager array transformations",
    description: "Detect adjacent filter/map or map/filter passes on locally evidenced arrays.",
    why: "Adjacent eager passes allocate an intermediate array. This optional policy reports only array literals, direct array annotations, immutable aliases, and supported array-preserving calls. Imported factories, property types, and generic aliases are not inferred. Iterator helpers are not guaranteed faster.",
    recommendedReplacement:
      "Review a single transformation or supported iterator helpers, preserving callback order, indexes, thisArg, and sparse-array behavior. Check target runtime support before using iterator helpers.",
    examples: [
      {
        title: "Review adjacent eager array transformations",
        language: "ts",
        invalid: "const values = [1, 2, 3].filter(value => value > 1).map(value => value * 2)",
        valid:
          "const values = [1, 2, 3].values().filter(value => value > 1).map(value => value * 2).toArray()",
      },
    ],
    category: "performance",
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
        if (node.type !== "CallExpression" || node.optional) return;
        const outer = arrayMethod(node.callee);
        if (!outer || !["map", "filter"].includes(outer.name)) return;
        const innerCall = expression(outer.object);
        if (innerCall?.type !== "CallExpression" || innerCall.optional) return;
        const inner = arrayMethod(innerCall.callee);
        if (
          !inner ||
          inner.name !== (outer.name === "map" ? "filter" : "map") ||
          !evidence.isArray(inner.object)
        )
          return;
        report(
          ctx,
          node,
          ruleId,
          "These adjacent eager array passes allocate an intermediate array.",
          "Review a single transformation or supported iterator helpers. Preserve callback order, indexes, thisArg, and sparse-array behavior; measure performance before changing the pipeline.",
        );
      },
    };
  },
});
