import { createRule } from "../../../core/index.js";
import { parameterType, report, type AnyNode } from "./shared.js";

import { createTypeAliasResolver } from "./type-aliases.js";

const ruleId = "typescript/evidence/no-object-parameters";
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSConstructorType",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "TSFunctionType",
  "TSMethodSignature",
]);

export const noObjectParameters = createRule({
  meta: {
    id: "typescript/evidence/no-object-parameters",
    title: "Use concrete input contracts instead of object",
    description: "Reject function parameters typed as the broad object type.",
    why: "The object type proves only that a value is not primitive. It gives the function no usable property contract and usually postpones parsing until after the input has crossed its owner boundary.",
    recommendedReplacement:
      "Accept a named owner type or parse unknown input before calling the function.",
    examples: [
      {
        title: "Name the accepted contract",
        language: "ts",
        invalid: "function save(value: object) {}",
        valid: "function save(value: SavedRecord) {}",
      },
    ],
    category: "evidence",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://github.com/dmmulroy/anti-slop#no-object-parameters",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    let resolver: ReturnType<typeof createTypeAliasResolver>;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") {
          resolver = createTypeAliasResolver(node);
          return;
        }
        if (!functionTypes.has(node.type)) return;
        for (const parameter of node.params ?? []) {
          const annotation = parameterType(parameter);
          if (!resolver.resolvesToKeyword(annotation, "TSObjectKeyword")) continue;
          report(
            ctx,
            annotation,
            ruleId,
            "This parameter accepts the broad object type without describing the properties the function owns.",
            "Replace object with a named input type, or parse unknown input before this call.",
          );
        }
      },
    };
  },
});
