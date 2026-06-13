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
        const init = node.arguments?.[1];
        if (init && hasNonSerializableUseStateValue(init, ctx.file.text)) {
          report(
            ctx,
            node,
            "nuxt/state/no-nonserializable-usestate",
            "error",
            "hydration",
            "useState() is serialized between server and client. Do not store functions, sockets, classes, Map/Set, or other non-serializable values.",
            "Store only JSON-serializable values in useState(), or keep live objects outside payload state.",
          );
        }
      },
    };
  },
});

function hasNonSerializableUseStateValue(node: AnyNode, source: string): boolean {
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return initializerReturnsNonSerializableValue(node.body, source);
  }
  return expressionTextHasNonSerializableValue(node, source);
}

function initializerReturnsNonSerializableValue(body: AnyNode, source: string): boolean {
  if (body.type !== "BlockStatement") return expressionTextHasNonSerializableValue(body, source);
  return (body.body ?? []).some((statement: AnyNode) => {
    return (
      statement.type === "ReturnStatement" &&
      statement.argument &&
      expressionTextHasNonSerializableValue(statement.argument, source)
    );
  });
}

function expressionTextHasNonSerializableValue(node: AnyNode, source: string): boolean {
  const text = source.slice(node.start, node.end);
  return /new\s+(?:WebSocket|Map|Set|Date|RegExp)\b|function\s*\(|=>\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(
    text,
  );
}
