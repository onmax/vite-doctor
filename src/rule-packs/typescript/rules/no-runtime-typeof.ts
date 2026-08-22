import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, report, type AnyNode } from "./shared.js";

const ruleId = "typescript/strict/no-runtime-typeof";

export const noRuntimeTypeof = createRule({
  meta: {
    id: "typescript/strict/no-runtime-typeof",
    title: "Parse runtime representations at their boundary",
    description: "Reject runtime typeof checks in the strict TypeScript preset.",
    why: "A typeof branch proves one JavaScript representation but rarely establishes the complete domain contract expected by downstream code.",
    recommendedReplacement:
      "Parse the value once at its input boundary and branch on the resulting domain value.",
    examples: [
      {
        title: "Parse before branching",
        language: "ts",
        invalid: "if (typeof input === 'string') useName(input)",
        valid: "const name = NameSchema.parse(input)\nuseName(name)",
      },
    ],
    category: "strict",
    severity: "warn",
    fixable: "structural-review",
    docsUrl: "https://github.com/dmmulroy/anti-slop#no-runtime-typeof",
    requires: { script: true },
    aiGeneratedCodeRisk: "medium",
  },
  create(ctx) {
    if (!isTypeScriptSource(ctx)) return {};
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "UnaryExpression" || node.operator !== "typeof") return;
        report(
          ctx,
          node,
          ruleId,
          "This typeof check narrows a representation without establishing its domain contract.",
          "Parse the input at its boundary, then branch on the parsed domain value.",
        );
      },
    };
  },
});
