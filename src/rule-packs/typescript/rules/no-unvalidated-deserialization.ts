import { createRule } from "../../../core/index.js";
import {
  isOutermostTypeAssertion,
  isTypeAssertion,
  report,
  unwrapExpression,
  type AnyNode,
} from "./shared.js";

const ruleId = "typescript/boundaries/no-unvalidated-deserialization";

export const noUnvalidatedDeserialization = createRule({
  meta: {
    id: "typescript/boundaries/no-unvalidated-deserialization",
    title: "Validate deserialized values before typing them",
    description:
      "Reject direct type claims on values returned by common deserialization boundaries.",
    why: "JSON, response bodies, and browser storage contain runtime data. A TypeScript annotation or assertion does not validate that data, so malformed values can enter the program under a trusted domain type.",
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
          if (isUntrustedDeserialization(node.expression) && !isUnknownType(node.typeAnnotation)) {
            reportBoundary(ctx, node);
          }
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
          isUntrustedDeserialization(node.init)
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

function isUntrustedDeserialization(expression: AnyNode): boolean {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" && callee?.type !== "StaticMemberExpression") {
    return false;
  }
  const objectName = callee.object?.name;
  const propertyName = callee.computed ? callee.property?.value : callee.property?.name;
  if (objectName === "JSON" && propertyName === "parse") return true;
  if (["localStorage", "sessionStorage"].includes(objectName) && propertyName === "getItem") {
    return true;
  }
  return propertyName === "json";
}

function isUnknownType(node: AnyNode): boolean {
  return node?.type === "TSUnknownKeyword";
}

function isAnyType(node: AnyNode): boolean {
  return node?.type === "TSAnyKeyword";
}
