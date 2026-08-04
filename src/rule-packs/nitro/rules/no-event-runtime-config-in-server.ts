import { type AnyNode, createRule, report } from "./shared.js";

export const noEventRuntimeConfigInServer = createRule({
  meta: {
    id: "nitro/runtime/no-event-runtime-config-in-server",
    title: "Remove the event argument from Nitro 3 runtime config",
    description: "Nitro 3 reads runtime config without a request event argument.",
    why: "Nitro 3 replaced the event-aware Nitro 2 signature with zero-argument useRuntimeConfig().",
    recommendedReplacement: "Use useRuntimeConfig() in Nitro 3 server code.",
    category: "runtime-config",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/migration",
    requires: { script: true, nitro: true },
    applicability: {
      runtimes: { nitro: ">=3.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useRuntimeConfig") || !node.arguments?.length) return;
        report(
          ctx,
          node,
          "nitro/runtime/no-event-runtime-config-in-server",
          "warn",
          "runtime-config",
          "Nitro 3 useRuntimeConfig() no longer accepts the request event.",
          "Remove the event argument and call useRuntimeConfig().",
        );
      },
    };
  },
});
