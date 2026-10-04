import { AnyNode, createRule, report } from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";

export const noNonSerializableUseState = createRule({
  meta: {
    id: "nuxt/state/no-nonserializable-usestate",
    title: "useState values must be serializable",
    category: "hydration",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-state#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useState")) return;
        if (!evidence.isPayloadSerialized(node)) return;
        const init = node.arguments?.[1] ?? node.arguments?.[0];
        if (init && hasNonSerializableUseStateValue(init)) {
          report(
            ctx,
            node,
            "nuxt/state/no-nonserializable-usestate",
            "error",
            "hydration",
            "useState() is serialized between server and client. Keep functions, live sockets, and other unsupported values out of payload state.",
            "Store values supported by Nuxt's payload serializer, or keep live objects outside payload state.",
          );
        }
      },
    };
  },
});

function unwrap(node: AnyNode): AnyNode {
  while (
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(node?.type)
  )
    node = node.expression;
  return node;
}

function hasNonSerializableUseStateValue(value: AnyNode): boolean {
  const node = unwrap(value);
  if (node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression") {
    return node.body.type === "BlockStatement"
      ? returnedValue(node.body).unsupported
      : hasUnsupportedPayloadValue(node.body);
  }
  return false;
}

function returnedValue(node: AnyNode): { unsupported: boolean; terminates: boolean } {
  const empty = { unsupported: false, terminates: false };
  if (!node) return empty;
  if (node.type === "ReturnStatement")
    return { unsupported: hasUnsupportedPayloadValue(node.argument), terminates: true };
  if (node.type === "ThrowStatement") return { unsupported: false, terminates: true };
  if (node.type === "BlockStatement") {
    let unsupported = false;
    for (const statement of node.body) {
      const result = returnedValue(statement);
      unsupported ||= result.unsupported;
      if (result.terminates) return { unsupported, terminates: true };
    }
    return { unsupported, terminates: false };
  }
  if (node.type === "TryStatement") {
    const finalizer = returnedValue(node.finalizer);
    if (finalizer.terminates) return finalizer;
    const block = returnedValue(node.block);
    const handler = returnedValue(node.handler?.body);
    const blockMayThrow = mayThrowBeforeTermination(node.block);
    const handlerReachable = Boolean(node.handler) && (!block.terminates || blockMayThrow);
    return {
      unsupported:
        finalizer.unsupported ||
        block.unsupported ||
        (handlerReachable ? handler.unsupported : false),
      terminates: block.terminates && (!node.handler || handler.terminates || !blockMayThrow),
    };
  }
  if (node.type === "IfStatement") {
    if (node.test.type === "Literal" && typeof node.test.value === "boolean")
      return returnedValue(node.test.value ? node.consequent : node.alternate);
    const consequent = returnedValue(node.consequent);
    const alternate = returnedValue(node.alternate);
    return {
      unsupported: consequent.unsupported || alternate.unsupported,
      terminates: consequent.terminates && alternate.terminates,
    };
  }
  return empty;
}

function mayThrowBeforeTermination(node: AnyNode): boolean {
  if (!node) return true;
  if (node.type === "BlockStatement")
    for (const statement of node.body) {
      if (statement.type === "ReturnStatement") return mayThrowExpression(statement.argument);
      if (statement.type === "ThrowStatement") return true;
      if (statement.type === "BlockStatement" || statement.type === "IfStatement") {
        if (mayThrowBeforeTermination(statement)) return true;
        continue;
      }
      return true;
    }
  return true;
}

function mayThrowExpression(value: AnyNode): boolean {
  const node = unwrap(value);
  if (!node) return false;
  if (
    ["Literal", "Identifier", "ArrowFunctionExpression", "FunctionExpression"].includes(node.type)
  )
    return false;
  if (node.type === "ObjectExpression")
    return node.properties.some((property: AnyNode) =>
      property.type === "SpreadElement" ? mayThrowExpression(property.argument) : false,
    );
  if (node.type === "ArrayExpression") return node.elements.some(mayThrowExpression);
  return true;
}

function hasUnsupportedPayloadValue(value: AnyNode): boolean {
  const node = unwrap(value);
  if (!node) return false;
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return true;
  if (node.type === "ConditionalExpression") {
    if (node.test.type === "Literal" && typeof node.test.value === "boolean")
      return hasUnsupportedPayloadValue(node.test.value ? node.consequent : node.alternate);
    return (
      hasUnsupportedPayloadValue(node.consequent) || hasUnsupportedPayloadValue(node.alternate)
    );
  }
  if (node.type === "SequenceExpression")
    return hasUnsupportedPayloadValue(node.expressions.at(-1));
  if (node.type === "ArrayExpression") return node.elements.some(hasUnsupportedPayloadValue);
  if (node.type === "SpreadElement") return hasUnsupportedPayloadValue(node.argument);
  if (node.type === "ObjectExpression")
    return [...payloadProperties(node).values()].some((property) => property.unsupported);
  if (node.type === "NewExpression" && node.callee?.type === "Identifier") {
    if (node.callee.name === "WebSocket") return true;
    if (node.callee.name === "Set") return hasUnsupportedPayloadValue(node.arguments[0]);
    if (node.callee.name === "Map") return hasUnsupportedMapValue(node.arguments[0]);
  }
  return false;
}

type PayloadProperty = { unsupported: boolean; kind: string };

function payloadProperties(node: AnyNode): Map<unknown, PayloadProperty> {
  const properties = new Map<unknown, PayloadProperty>();
  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      const spread = unwrap(property.argument);
      if (spread?.type === "ObjectExpression")
        for (const [key, value] of payloadProperties(spread))
          properties.set(key, { ...value, kind: "init" });
      continue;
    }
    const key = propertyKey(property);
    if (property.kind === "set" && properties.get(key)?.kind === "get") continue;
    properties.set(key, {
      kind: property.kind,
      unsupported:
        property.kind === "set"
          ? false
          : property.kind === "get"
            ? returnedValue(property.value.body).unsupported
            : hasUnsupportedPayloadValue(property.value),
    });
  }
  return properties;
}

function propertyKey(property: AnyNode): unknown {
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  if (["Literal", "StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(property.key.type))
    return String(property.key.value);
  return property;
}

function hasUnsupportedMapValue(value: AnyNode): boolean {
  const node = unwrap(value);
  if (node?.type !== "ArrayExpression") return false;
  const entries = new Map<unknown, boolean>();
  for (const element of node.elements) {
    const entry = unwrap(element);
    if (entry?.type !== "ArrayExpression") continue;
    const key = unwrap(entry.elements[0]);
    entries.set(
      key?.type === "Literal" ? key.value : entry,
      hasUnsupportedPayloadValue(key) || hasUnsupportedPayloadValue(entry.elements[1]),
    );
  }
  return [...entries.values()].some(Boolean);
}
