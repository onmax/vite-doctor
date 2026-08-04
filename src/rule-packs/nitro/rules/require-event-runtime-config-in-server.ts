import { AnyNode, createRule, report } from "./shared.js";

export const requireEventRuntimeConfigInServer = createRule({
  meta: {
    id: "nitro/runtime/require-event-runtime-config-in-server",
    title: "Pass event to useRuntimeConfig in server handlers",
    description: "Read runtime config with the Nitro event inside server handlers.",
    why: "Passing the event lets Nitro resolve request-aware runtime config consistently in server code.",
    recommendedReplacement: "Use useRuntimeConfig(event).",
    category: "runtime-config",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/configuration#runtime-configuration",
    requires: { script: true, nitro: true },
    applicability: { runtimes: { nitro: ">=2 <3" } },
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
          "nitro/runtime/require-event-runtime-config-in-server",
          "warn",
          "runtime-config",
          "Server handlers should read runtime config with the request event.",
          "Use useRuntimeConfig(event).",
        );
      },
    };
  },
});
