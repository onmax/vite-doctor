import { createRule, type RuleContext } from "../../../core/index.js";
import { createLocalEvidence } from "./local-evidence.js";
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
const fetchBodyTypeNames = ["Request", "Response"];

type LocalEvidence = ReturnType<typeof createLocalEvidence>;

export const noUnvalidatedDeserialization = createRule({
  meta: {
    id: "typescript/boundaries/no-unvalidated-deserialization",
    title: "Validate deserialized values before typing them",
    description:
      "Reject direct type claims on values returned by JSON parsing, Fetch API bodies, and browser storage.",
    why: "JSON, Fetch API bodies, and browser storage contain runtime data. A TypeScript annotation or assertion does not validate that data, so malformed values can enter the program under a trusted domain type.",
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
    severity: "warn",
    fixable: "structural-review",
    docsUrl: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    let evidence: LocalEvidence;
    const isUntrustedDeserialization = (expression: AnyNode) =>
      isUntrustedValue(ctx, evidence, expression);
    const visitAssertion = (node: AnyNode) => {
      if (!isOutermostTypeAssertion(node)) return;
      if (isUntrustedDeserialization(node.expression) && !isUnknownType(node.typeAnnotation)) {
        reportBoundary(ctx, node);
      }
    };
    return {
      Program(node: AnyNode) {
        evidence = createLocalEvidence(node);
      },
      TSAsExpression: visitAssertion,
      TSTypeAssertion: visitAssertion,
      ReturnStatement(node: AnyNode) {
        if (!node.argument || isTypeAssertion(node.argument)) return;
        const owner = containingFunction(node);
        if (hasConcreteReturnType(owner) && isUntrustedDeserialization(node.argument)) {
          reportBoundary(ctx, node.argument);
        }
      },
      ArrowFunctionExpression(node: AnyNode) {
        if (
          node.body?.type !== "BlockStatement" &&
          !isTypeAssertion(node.body) &&
          hasConcreteReturnType(node) &&
          isUntrustedDeserialization(node.body)
        ) {
          reportBoundary(ctx, node.body);
        }
      },
      PropertyDefinition(node: AnyNode) {
        if (!node.value) return;
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (
          annotation &&
          !isUnknownType(annotation) &&
          !isAnyType(annotation) &&
          isUntrustedDeserialization(node.value)
        ) {
          reportBoundary(ctx, node.value);
        }
      },
      VariableDeclarator(node: AnyNode) {
        if (!node.init) return;
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

function isUntrustedValue(ctx: RuleContext, evidence: LocalEvidence, expression: AnyNode) {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" && callee?.type !== "StaticMemberExpression") {
    return false;
  }
  const objectName = deserializerObjectName(ctx, callee.object);
  const propertyName = memberPropertyName(callee);
  if (objectName === "JSON" && propertyName === "parse") {
    return !isJsonStringifyCall(ctx, node.arguments?.[0]);
  }
  if (
    objectName &&
    ["localStorage", "sessionStorage"].includes(objectName) &&
    propertyName === "getItem"
  ) {
    return true;
  }
  return (
    propertyName === "json" &&
    !node.optional &&
    !node.arguments?.length &&
    isFetchBody(evidence, callee.object)
  );
}

// Without type information, only a Fetch API annotation or an unshadowed fetch() result proves a body.
function isFetchBody(evidence: LocalEvidence, receiver: AnyNode): boolean {
  const node = unwrapExpression(receiver);
  if (isGlobalFetchCall(evidence, node)) return true;
  const target = evidence.binding(node);
  if (!target || target.written || target.node.start >= node.start) return false;
  if (
    target.annotation &&
    fetchBodyTypeNames.some((name) => evidence.globalType(target.annotation, name))
  ) {
    return true;
  }
  return target.kind === "const" && isGlobalFetchCall(evidence, unwrapExpression(target.init));
}

function isGlobalFetchCall(evidence: LocalEvidence, node: AnyNode): boolean {
  if (node?.type !== "CallExpression") return false;
  const callee = unwrapExpression(node.callee);
  if (callee?.type === "Identifier") return callee.name === "fetch" && !evidence.binding(callee);
  return (
    (callee?.type === "MemberExpression" || callee?.type === "StaticMemberExpression") &&
    memberPropertyName(callee) === "fetch" &&
    callee.object?.type === "Identifier" &&
    globalObjectNames.has(callee.object.name) &&
    !evidence.binding(callee.object) &&
    !evidence.propertyWritten(callee.object.name, "fetch")
  );
}

function isJsonStringifyCall(ctx: RuleContext, expression: AnyNode): boolean {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" && callee?.type !== "StaticMemberExpression") {
    return false;
  }
  return (
    deserializerObjectName(ctx, callee.object) === "JSON" &&
    memberPropertyName(callee) === "stringify"
  );
}

function deserializerObjectName(ctx: RuleContext, node: AnyNode): string | null {
  if (node?.type === "Identifier") {
    if (!deserializerObjectNames.has(node.name)) return null;
    return ctx.helpers.hasLocalBinding(node) ? null : node.name;
  }
  if (node?.type !== "MemberExpression" && node?.type !== "StaticMemberExpression") return null;
  if (node.object?.type !== "Identifier" || !globalObjectNames.has(node.object.name)) return null;
  if (ctx.helpers.hasLocalBinding(node.object)) return null;
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
  if (node?.type === "TSUnknownKeyword") return true;
  if (node?.type === "TSParenthesizedType") return isUnknownType(node.typeAnnotation);
  return node?.type === "TSUnionType" && isNullableUnknownShape(node.types);
}

// Property reads on any JSON value except null are safe, and TypeScript forces `?.` on optional
// members, so `{ key?: unknown } | null` claims nothing the runtime value can violate.
function isNullableUnknownShape(types: AnyNode[]): boolean {
  return (
    types.some((item) => item.type === "TSNullKeyword") &&
    types.some((item) => isOptionalUnknownShape(item)) &&
    types.every(
      (item) =>
        item.type === "TSNullKeyword" ||
        item.type === "TSUndefinedKeyword" ||
        isOptionalUnknownShape(item),
    )
  );
}

function isOptionalUnknownShape(node: AnyNode): boolean {
  if (node?.type === "TSParenthesizedType") return isOptionalUnknownShape(node.typeAnnotation);
  if (node?.type !== "TSTypeLiteral" || !node.members?.length) return false;
  return node.members.every((member: AnyNode) => {
    const type = member.typeAnnotation?.typeAnnotation;
    return (
      member.type === "TSPropertySignature" &&
      member.optional === true &&
      (type?.type === "TSUnknownKeyword" || isOptionalUnknownShape(type))
    );
  });
}

function isAnyType(node: AnyNode): boolean {
  return node?.type === "TSAnyKeyword";
}
