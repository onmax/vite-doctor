import { AnyNode, createRule, report } from "./shared.js";

export const requireEventRuntimeConfigInServer = createRule({
  meta: {
    id: "nuxt/runtime/require-event-runtime-config-in-server",
    title: "Pass event to useRuntimeConfig in server handlers",
    category: "runtime-config",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useRuntimeConfig")) return;
        if (node.arguments?.length) return;
        report(
          ctx,
          node,
          "nuxt/runtime/require-event-runtime-config-in-server",
          "warn",
          "runtime-config",
          "Server handlers should read runtime config with the request event.",
          "Use useRuntimeConfig(event).",
        );
      },
    };
  },
});
