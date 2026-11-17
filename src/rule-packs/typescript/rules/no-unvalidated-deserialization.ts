import { createRule, type RuleContext } from "../../../core/index.js";
import {
  acceptsStorageItem,
  createTypeScope,
  isHonestJsonType,
  type TypeScope,
} from "./json-type-claims.js";
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
      "Deserialize to unknown, or to a JSON type that claims nothing about the contents (unknown[], Record<string, unknown>, a JSON value union), and validate with the domain parser before using the value. Keep browser storage reads as string | null.",
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
    confidence: "heuristic-high",
    fixable: "structural-review",
    docsUrl: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    let evidence: LocalEvidence;
    let types: TypeScope;
    const checkClaim = (value: AnyNode, claim: AnyNode, at: AnyNode = value) => {
      const source = untrustedSource(ctx, evidence, value);
      if (!source || isHonestClaim(ctx, types, source, claim)) return;
      reportBoundary(ctx, at, source, claim);
    };
    const visitAssertion = (node: AnyNode) => {
      if (isOutermostTypeAssertion(node)) checkClaim(node.expression, node.typeAnnotation, node);
    };
    return {
      Program(node: AnyNode) {
        evidence = createLocalEvidence(node);
        types = createTypeScope(ctx.file.path, node);
      },
      TSAsExpression: visitAssertion,
      TSTypeAssertion: visitAssertion,
      ReturnStatement(node: AnyNode) {
        if (!node.argument || isTypeAssertion(node.argument)) return;
        const claim = declaredReturnType(
          containingFunction(node),
          untrustedSource(ctx, evidence, node.argument)?.label.endsWith(".json()") === true,
        );
        if (claim) checkClaim(node.argument, claim);
      },
      ArrowFunctionExpression(node: AnyNode) {
        if (node.body?.type === "BlockStatement" || isTypeAssertion(node.body)) return;
        const claim = declaredReturnType(
          node,
          untrustedSource(ctx, evidence, node.body)?.label.endsWith(".json()") === true,
        );
        if (claim) checkClaim(node.body, claim);
      },
      PropertyDefinition(node: AnyNode) {
        const claim = node.typeAnnotation?.typeAnnotation;
        if (node.value && claim && !isAnyType(claim)) checkClaim(node.value, claim);
      },
      VariableDeclarator(node: AnyNode) {
        const claim = node.id.typeAnnotation?.typeAnnotation;
        if (node.init && claim && !isAnyType(claim)) checkClaim(node.init, claim);
      },
    };
  },
});

type UntrustedSource = { label: string; kind: "json" | "storage" };

function isHonestClaim(
  ctx: RuleContext,
  types: TypeScope,
  source: UntrustedSource,
  claim: AnyNode,
): boolean {
  return source.kind === "storage"
    ? acceptsStorageItem(ctx, types, claim)
    : isHonestJsonType(ctx, types, claim);
}

function reportBoundary(ctx: RuleContext, node: AnyNode, source: UntrustedSource, claim: AnyNode) {
  const type = typeText(ctx, claim);
  if (source.kind === "storage") {
    report(
      ctx,
      node,
      ruleId,
      `\`${source.label}\` returns \`string | null\`, but this code types the result as \`${type}\`.`,
      `Keep the result as \`string | null\`, handle null, and parse the string with the domain schema before treating it as \`${type}\`.`,
    );
    return;
  }
  report(
    ctx,
    node,
    ruleId,
    `\`${source.label}\` returns unvalidated runtime data, but this code types it as \`${type}\`.`,
    `Type the result as \`unknown\` (or \`unknown[]\`, \`Record<string, unknown>\`, a JSON value type) and validate it with the domain schema or a type guard before using it as \`${type}\`.`,
  );
}

function typeText(ctx: RuleContext, node: AnyNode): string {
  const text = ctx.file.text.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function untrustedSource(
  ctx: RuleContext,
  evidence: LocalEvidence,
  expression: AnyNode,
): UntrustedSource | null {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" && callee?.type !== "StaticMemberExpression") {
    return null;
  }
  const objectName = deserializerObjectName(ctx, callee.object);
  const propertyName = memberPropertyName(callee);
  if (objectName === "JSON" && propertyName === "parse") {
    return isJsonStringifyCall(ctx, node.arguments?.[0])
      ? null
      : { label: "JSON.parse()", kind: "json" };
  }
  if (
    objectName &&
    ["localStorage", "sessionStorage"].includes(objectName) &&
    propertyName === "getItem"
  ) {
    return { label: `${objectName}.getItem()`, kind: "storage" };
  }
  if (
    propertyName !== "json" ||
    node.optional ||
    node.arguments?.length ||
    !isFetchBody(evidence, callee.object)
  ) {
    return null;
  }
  const receiver = unwrapExpression(callee.object);
  const label = receiver?.type === "Identifier" ? `${receiver.name}.json()` : "Response.json()";
  return { label, kind: "json" };
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

function declaredReturnType(node: AnyNode, fetchPromise: boolean): AnyNode {
  let annotation = node?.returnType?.typeAnnotation;
  // `async` bodies and `.json()` both resolve the Promise, so the claim is about its contents.
  if (
    (node?.async || fetchPromise) &&
    annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier" &&
    annotation.typeName.name === "Promise" &&
    annotation.typeArguments?.params?.length === 1
  ) {
    annotation = annotation.typeArguments.params[0];
  }
  return annotation && !isAnyType(annotation) ? annotation : null;
}

function isAnyType(node: AnyNode): boolean {
  return node?.type === "TSAnyKeyword";
}
