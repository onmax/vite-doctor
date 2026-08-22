import { createRule, type RuleContext } from "../../../core/index.js";
import {
  isOutermostTypeAssertion,
  isTypeAssertion,
  report,
  unwrapExpression,
  type AnyNode,
} from "./shared.js";

const ruleId = "typescript/boundaries/no-unvalidated-deserialization";
const globalObjectNames = new Set(["globalThis", "window"]);
const deserializerObjectNames = new Set(["JSON", "localStorage", "sessionStorage"]);

export const noUnvalidatedDeserialization = createRule({
  meta: {
    id: "typescript/boundaries/no-unvalidated-deserialization",
    title: "Validate deserialized values before typing them",
    description:
      "Reject direct type claims on values returned by JSON parsing and browser storage.",
    why: "JSON and browser storage contain runtime data. A TypeScript annotation or assertion does not validate that data, so malformed values can enter the program under a trusted domain type.",
    recommendedReplacement:
      "Deserialize to unknown and validate with the domain parser before using the value.",
    examples: [
      {
        title: "Validate JSON at the boundary",
        language: "ts",
        invalid: "const user = JSON.parse(text) as User",
        valid: "const user = UserSchema.parse(JSON.parse(text))",
      },
    ],
    category: "boundaries",
    severity: "error",
    fixable: "structural-review",
    docsUrl: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (isTypeAssertion(node) && isOutermostTypeAssertion(node)) {
          if (
            isUntrustedDeserialization(ctx, node.expression) &&
            !isUnknownType(node.typeAnnotation)
          ) {
            reportBoundary(ctx, node);
          }
          return;
        }
        if (node.type === "ReturnStatement" && node.argument && !isTypeAssertion(node.argument)) {
          const owner = containingFunction(node);
          if (hasConcreteReturnType(owner) && isUntrustedDeserialization(ctx, node.argument)) {
            reportBoundary(ctx, node.argument);
          }
          return;
        }
        if (
          node.type === "ArrowFunctionExpression" &&
          node.body?.type !== "BlockStatement" &&
          !isTypeAssertion(node.body) &&
          hasConcreteReturnType(node) &&
          isUntrustedDeserialization(ctx, node.body)
        ) {
          reportBoundary(ctx, node.body);
          return;
        }
        if (node.type !== "VariableDeclarator" || !node.init || node.id?.type !== "Identifier") {
          return;
        }
        const annotation = node.id.typeAnnotation?.typeAnnotation;
        if (
          annotation &&
          !isUnknownType(annotation) &&
          !isAnyType(annotation) &&
          isUntrustedDeserialization(ctx, node.init)
        ) {
          reportBoundary(ctx, node.init);
        }
      },
    };
  },
});

function reportBoundary(ctx: Parameters<typeof report>[0], node: AnyNode) {
  report(
    ctx,
    node,
    ruleId,
    "This runtime value receives a TypeScript contract without validation.",
    "Deserialize to unknown and run the domain schema or parser before using the result.",
  );
}

function isUntrustedDeserialization(ctx: RuleContext, expression: AnyNode): boolean {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" && callee?.type !== "StaticMemberExpression") {
    return false;
  }
  const objectName = deserializerObjectName(ctx, callee.object);
  const propertyName = memberPropertyName(callee);
  if (objectName === "JSON" && propertyName === "parse") return true;
  if (
    objectName &&
    ["localStorage", "sessionStorage"].includes(objectName) &&
    propertyName === "getItem"
  ) {
    return true;
  }
  return false;
}

function deserializerObjectName(ctx: RuleContext, node: AnyNode): string | null {
  if (node?.type === "Identifier") {
    if (!deserializerObjectNames.has(node.name)) return null;
    return ctx.helpers.hasLocalBindingBefore(node, ctx.file.text) ? null : node.name;
  }
  if (node?.type !== "MemberExpression" && node?.type !== "StaticMemberExpression") return null;
  if (node.object?.type !== "Identifier" || !globalObjectNames.has(node.object.name)) return null;
  if (ctx.helpers.hasLocalBindingBefore(node.object, ctx.file.text)) return null;
  const propertyName = memberPropertyName(node);
  return propertyName && deserializerObjectNames.has(propertyName) ? propertyName : null;
}

function memberPropertyName(node: AnyNode): string | null {
  const name = node.computed ? node.property?.value : node.property?.name;
  return typeof name === "string" ? name : null;
}

function containingFunction(node: AnyNode): AnyNode {
  let current = node?.__doctorParent ?? node?.parent;
  while (current) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    ) {
      return current;
    }
    current = current.__doctorParent ?? current.parent;
  }
  return null;
}

function hasConcreteReturnType(node: AnyNode): boolean {
  let annotation = node?.returnType?.typeAnnotation;
  if (
    node?.async &&
    annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier" &&
    annotation.typeName.name === "Promise" &&
    annotation.typeArguments?.params?.length === 1
  ) {
    annotation = annotation.typeArguments.params[0];
  }
  return Boolean(annotation && !isUnknownType(annotation) && !isAnyType(annotation));
}

function isUnknownType(node: AnyNode): boolean {
  return node?.type === "TSUnknownKeyword";
}

function isAnyType(node: AnyNode): boolean {
  return node?.type === "TSAnyKeyword";
}
