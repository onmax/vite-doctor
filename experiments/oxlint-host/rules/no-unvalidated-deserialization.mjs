import { hasLocalBindingBefore, parentOf, reportDoctor } from "./shared.mjs";

const CODE = "TS0005";
const WHY = "This runtime value receives a TypeScript contract without validation.";
const globalObjectNames = new Set(["globalThis", "window"]);
const deserializerObjectNames = new Set(["JSON", "localStorage", "sessionStorage"]);
const WRAPPERS = new Set([
  "AwaitExpression",
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** Port of `typescript/boundaries/no-unvalidated-deserialization`, split into typed visitors. */
export const noUnvalidatedDeserialization = {
  meta: { type: "problem", docs: { url: "https://vite-doctor.onmax.me/diagnostics/TS0005" } },
  create(context) {
    const source = context.sourceCode.text;
    const untrusted = (expression) => isUntrustedDeserialization(source, expression);
    const assertion = (node) => {
      if (!isOutermostTypeAssertion(node)) return;
      if (untrusted(node.expression) && node.typeAnnotation?.type !== "TSUnknownKeyword")
        reportDoctor(context, node, CODE, WHY);
    };
    return {
      TSAsExpression: assertion,
      TSTypeAssertion: assertion,
      ReturnStatement(node) {
        if (!node.argument || isTypeAssertion(node.argument)) return;
        if (hasConcreteReturnType(containingFunction(node)) && untrusted(node.argument))
          reportDoctor(context, node.argument, CODE, WHY);
      },
      ArrowFunctionExpression(node) {
        if (
          node.body?.type !== "BlockStatement" &&
          !isTypeAssertion(node.body) &&
          hasConcreteReturnType(node) &&
          untrusted(node.body)
        )
          reportDoctor(context, node.body, CODE, WHY);
      },
      PropertyDefinition(node) {
        if (!node.value) return;
        if (isConcreteAnnotation(node.typeAnnotation?.typeAnnotation) && untrusted(node.value))
          reportDoctor(context, node.value, CODE, WHY);
      },
      VariableDeclarator(node) {
        if (!node.init) return;
        if (isConcreteAnnotation(node.id.typeAnnotation?.typeAnnotation) && untrusted(node.init))
          reportDoctor(context, node.init, CODE, WHY);
      },
    };
  },
};

function isConcreteAnnotation(annotation) {
  return Boolean(
    annotation && annotation.type !== "TSUnknownKeyword" && annotation.type !== "TSAnyKeyword",
  );
}

function isTypeAssertion(node) {
  return node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion";
}

function isOutermostTypeAssertion(node) {
  let current = node;
  let parent = parentOf(node);
  while (parent?.type === "ParenthesizedExpression" && parent.expression === current) {
    current = parent;
    parent = parentOf(parent);
  }
  return !isTypeAssertion(parent) || parent.expression !== current;
}

function unwrapExpression(node) {
  let current = node;
  while (current && WRAPPERS.has(current.type)) current = current.argument ?? current.expression;
  return current;
}

function isUntrustedDeserialization(source, expression) {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression" || node.callee?.type !== "MemberExpression") return false;
  const objectName = deserializerObjectName(source, node.callee.object);
  const propertyName = memberPropertyName(node.callee);
  if (objectName === "JSON" && propertyName === "parse")
    return !isJsonStringifyCall(source, node.arguments?.[0]);
  return (
    (objectName === "localStorage" || objectName === "sessionStorage") && propertyName === "getItem"
  );
}

function isJsonStringifyCall(source, expression) {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression" || node.callee?.type !== "MemberExpression") return false;
  return (
    deserializerObjectName(source, node.callee.object) === "JSON" &&
    memberPropertyName(node.callee) === "stringify"
  );
}

function deserializerObjectName(source, node) {
  if (node?.type === "Identifier") {
    if (!deserializerObjectNames.has(node.name)) return null;
    return hasLocalBindingBefore(node, source) ? null : node.name;
  }
  if (node?.type !== "MemberExpression") return null;
  if (node.object?.type !== "Identifier" || !globalObjectNames.has(node.object.name)) return null;
  if (hasLocalBindingBefore(node.object, source)) return null;
  const propertyName = memberPropertyName(node);
  return propertyName && deserializerObjectNames.has(propertyName) ? propertyName : null;
}

function memberPropertyName(node) {
  const name = node.computed ? node.property?.value : node.property?.name;
  return typeof name === "string" ? name : null;
}

function containingFunction(node) {
  let current = parentOf(node);
  while (current) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    )
      return current;
    current = parentOf(current);
  }
  return null;
}

function hasConcreteReturnType(node) {
  let annotation = node?.returnType?.typeAnnotation;
  if (
    node?.async &&
    annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier" &&
    annotation.typeName.name === "Promise" &&
    annotation.typeArguments?.params?.length === 1
  )
    annotation = annotation.typeArguments.params[0];
  return isConcreteAnnotation(annotation);
}
