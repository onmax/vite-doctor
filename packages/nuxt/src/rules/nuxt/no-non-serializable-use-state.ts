import { AnyNode, createRule, report } from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";

export const noNonSerializableUseState = createRule({
  meta: {
    id: "nuxt/state/no-nonserializable-usestate",
    title: "useState values must be serializable",
    category: "hydration",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useState")) return;
        if (!evidence.isPayloadSerialized(node)) return;
        const init = node.arguments?.[1];
        const text = init ? ctx.file.text.slice(init.start, init.end) : "";
        if (/new\s+(WebSocket|Map|Set|Date|RegExp)|=>\s*\([^)]*\)\s*=>|function\s*\(/.test(text)) {
          report(
            ctx,
            node,
            "nuxt/state/no-nonserializable-usestate",
            "error",
            "hydration",
            "useState() is serialized between server and client. Do not store functions, sockets, classes, Map/Set, or other non-serializable values.",
          );
        }
      },
    };
  },
});
