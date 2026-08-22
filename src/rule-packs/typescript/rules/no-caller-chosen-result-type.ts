import { createRule } from "../../../core/index.js";
import { collectTypeIdentifiers, parameterType, report, type AnyNode } from "./shared.js";

const ruleId = "typescript/evidence/no-caller-chosen-result-type";
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

export const noCallerChosenResultType = createRule({
  meta: {
    id: "typescript/evidence/no-caller-chosen-result-type",
    title: "Do not let callers invent result types",
    description:
      "Reject function type parameters used in the result type without appearing in any input.",
    why: "A generic result type needs evidence from an argument or an owning type. When a function returns a caller-selected type without receiving that evidence, calls such as parse<User>() ask TypeScript to trust a claim the implementation cannot verify.",
    recommendedReplacement:
      "Accept a parser, schema, constructor, or typed input that determines the result type.",
    examples: [
      {
        title: "Pass the parser that proves the result",
        language: "ts",
        invalid: "function parse<T>(text: string): T { return JSON.parse(text) }",
        valid:
          "function parse<T>(text: string, schema: Schema<T>): T { return schema.parse(JSON.parse(text)) }",
      },
    ],
    category: "evidence",
    severity: "error",
    fixable: "structural-review",
    docsUrl: "https://www.typescriptlang.org/docs/handbook/2/generics.html",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!functionTypes.has(node.type)) return;
        const typeParameters = node.typeParameters?.params ?? [];
        const returnType = node.returnType?.typeAnnotation;
        if (!typeParameters.length || !returnType) return;
        const inputTypes = new Set<string>();
        for (const parameter of node.params ?? []) {
          collectTypeIdentifiers(parameterType(parameter), inputTypes);
        }
        const resultTypes = collectTypeIdentifiers(returnType);
        for (const parameter of typeParameters) {
          const name = parameter.name?.name ?? parameter.name;
          if (typeof name !== "string" || !resultTypes.has(name) || inputTypes.has(name)) continue;
          report(
            ctx,
            parameter,
            ruleId,
            `Type parameter "${name}" affects the result but no input provides evidence for it.`,
            "Accept a schema, parser, constructor, or typed value that determines the result type.",
          );
        }
      },
    };
  },
});
