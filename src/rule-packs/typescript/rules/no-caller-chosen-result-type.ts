import { createRule } from "../../../core/index.js";
import { collectTypeIdentifiers, parentOf, report, type AnyNode } from "./shared.js";

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
        if (node.type === "TSFunctionType" && isConditionalTypeOperand(node)) return;
        const typeParameters = node.typeParameters?.params ?? [];
        const returnType = node.returnType?.typeAnnotation;
        if (!typeParameters.length || !returnType) return;
        const inputTypes = new Set<string>();
        for (const parameter of node.params ?? []) {
          collectTypeIdentifiers(parameter, inputTypes);
        }
        expandInputEvidence(inputTypes, typeParameters);
        const resultTypes = collectUnprovenResultTypeIdentifiers(returnType);
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

function collectUnprovenResultTypeIdentifiers(
  node: AnyNode,
  names = new Set<string>(),
): Set<string> {
  if (!node || typeof node !== "object") return names;
  if (Array.isArray(node)) {
    for (const child of node) collectUnprovenResultTypeIdentifiers(child, names);
    return names;
  }
  if (functionTypes.has(node.type)) {
    const callableResults = collectUnprovenResultTypeIdentifiers(node.returnType?.typeAnnotation);
    const callableInputs = new Set<string>();
    for (const parameter of node.params ?? []) collectTypeIdentifiers(parameter, callableInputs);
    for (const name of callableResults) {
      if (!callableInputs.has(name)) names.add(name);
    }
    return names;
  }
  if (node.type === "TSTypeReference" && node.typeName?.type === "Identifier") {
    names.add(node.typeName.name);
  }
  if (node.type === "Identifier" && parentOf(node)?.type === "TSTypeQuery") {
    names.add(node.name);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    collectUnprovenResultTypeIdentifiers(value, names);
  }
  return names;
}

function isConditionalTypeOperand(node: AnyNode): boolean {
  let current = node;
  let parent = parentOf(current);
  while (parent?.type === "TSParenthesizedType") {
    current = parent;
    parent = parentOf(current);
  }
  return (
    parent?.type === "TSConditionalType" &&
    (parent.checkType === current || parent.extendsType === current)
  );
}

function expandInputEvidence(inputTypes: Set<string>, typeParameters: AnyNode[]): void {
  const parametersByName = new Map<string, AnyNode>();
  for (const parameter of typeParameters) {
    const name = parameter.name?.name ?? parameter.name;
    if (typeof name === "string") parametersByName.set(name, parameter);
  }

  const pending = [...inputTypes];
  while (pending.length) {
    const name = pending.pop();
    if (!name) continue;
    const constraint = parametersByName.get(name)?.constraint;
    if (!constraint) continue;
    for (const dependency of collectTypeIdentifiers(constraint)) {
      if (!parametersByName.has(dependency) || inputTypes.has(dependency)) continue;
      inputTypes.add(dependency);
      pending.push(dependency);
    }
  }
}
