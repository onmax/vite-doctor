import { createRule } from "../../../core/index.js";
import { getNodeVisitorKeys } from "../../../core/internal/visitor-keys.js";
import { parameterType, parentOf, report, type AnyNode } from "./shared.js";

import { createLocalEvidence, expression } from "./local-evidence.js";
import { createTypeAliasResolver } from "./type-aliases.js";

const ruleId = "typescript/evidence/no-object-parameters";

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
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/dmmulroy/anti-slop#no-object-parameters",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    let evidence: ReturnType<typeof createLocalEvidence>;
    let resolver: ReturnType<typeof createTypeAliasResolver>;
    const visitFunction = (node: AnyNode) => {
      for (const parameter of node.params ?? []) {
        const annotation = parameterType(parameter);
        if (!resolver.resolvesToKeyword(annotation, "TSObjectKeyword")) continue;
        if (usedOnlyForIdentityOrReflection(node, parameter, evidence)) continue;
        report(
          ctx,
          annotation,
          ruleId,
          "This parameter accepts the broad object type without describing the properties the function owns.",
          "Replace object with a named input type, or parse unknown input before this call.",
        );
      }
    };
    return {
      Program(node: AnyNode) {
        resolver = createTypeAliasResolver(node);
        evidence = createLocalEvidence(node);
      },
      ArrowFunctionExpression: visitFunction,
      FunctionDeclaration: visitFunction,
      FunctionExpression: visitFunction,
      TSCallSignatureDeclaration: visitFunction,
      TSConstructSignatureDeclaration: visitFunction,
      TSConstructorType: visitFunction,
      TSDeclareFunction: visitFunction,
      TSEmptyBodyFunctionExpression: visitFunction,
      TSFunctionType: visitFunction,
      TSMethodSignature: visitFunction,
    };
  },
});

const COLLECTION_KEY_METHODS = new Set(["get", "set", "has", "delete", "add"]);
const OBJECT_REFLECTION = new Set([
  "keys",
  "values",
  "entries",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "defineProperty",
  "defineProperties",
  "hasOwn",
  "isFrozen",
  "isSealed",
  "isExtensible",
  "freeze",
  "seal",
  "preventExtensions",
]);

// `object` is the exact contract for a value that is only a WeakMap or WeakSet key, a Reflect or
// Object reflection argument, or the right side of `in`: those APIs accept any non-primitive.
function usedOnlyForIdentityOrReflection(
  fn: AnyNode,
  parameter: AnyNode,
  evidence: ReturnType<typeof createLocalEvidence>,
): boolean {
  const name = (parameter.type === "AssignmentPattern" ? parameter.left : parameter)?.name;
  if (typeof name !== "string" || !fn.body) return false;
  const uses: AnyNode[] = [];
  const visit = (node: AnyNode) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "Identifier" && node.name === name && isValueReference(node)) uses.push(node);
    for (const key of getNodeVisitorKeys(node)) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) visit(child);
    }
  };
  visit(fn.body);
  return uses.length > 0 && uses.every((use) => isIdentityOrReflectionUse(use, evidence));
}

function isValueReference(node: AnyNode): boolean {
  const parent = parentOf(node);
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  if (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
    return false;
  return parent?.type !== "TSTypeQuery" && parent?.type !== "TSQualifiedName";
}

function isIdentityOrReflectionUse(
  node: AnyNode,
  evidence: ReturnType<typeof createLocalEvidence>,
): boolean {
  let current = node;
  while (["TSNonNullExpression", "ParenthesizedExpression"].includes(parentOf(current)?.type))
    current = parentOf(current);
  const parent = parentOf(current);
  if (parent?.type === "BinaryExpression")
    return parent.operator === "in" && parent.right === current;
  if (parent?.type !== "CallExpression" || parent.arguments?.[0] !== current) return false;
  const callee = parent.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const method = callee.property?.name;
  const receiver = callee.object;
  if (receiver?.type === "Identifier" && receiver.name === "Reflect" && !evidence.binding(receiver))
    return true;
  if (receiver?.type === "Identifier" && receiver.name === "Object" && !evidence.binding(receiver))
    return OBJECT_REFLECTION.has(method);
  if (!COLLECTION_KEY_METHODS.has(method)) return false;
  const binding = evidence.binding(receiver);
  if (!binding || binding.written) return false;
  const init = expression(binding.init, true);
  const constructed =
    init?.type === "NewExpression" &&
    init.callee?.type === "Identifier" &&
    !evidence.binding(init.callee)
      ? init.callee.name
      : undefined;
  const collection = ["Map", "WeakMap", "Set", "WeakSet"].find(
    (name) => constructed === name || evidence.globalType(binding.annotation, name),
  );
  return ["Map", "WeakMap"].includes(collection ?? "")
    ? method !== "add"
    : ["Set", "WeakSet"].includes(collection ?? "") && ["has", "delete", "add"].includes(method);
}
