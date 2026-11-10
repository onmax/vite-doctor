import { AnyNode, createRule, isNitroServerFile, report } from "./shared.js";

export const noProcessEnvInServer = createRule({
  meta: {
    id: "nitro/runtime/no-process-env-in-server",
    title: "Read server settings from runtime config, not process.env",
    description: "Flags process.env reads in Nitro server files.",
    why: "Nitro maps NITRO_ and NUXT_ environment variables onto runtimeConfig at startup, with types and defaults in one place. process.env is empty on Cloudflare Workers and other runtimes without a Node process, and a key read straight from it bypasses that contract.",
    recommendedReplacement:
      "Declare the setting in runtimeConfig and read it with useRuntimeConfig(); override it with NUXT_<KEY> or NITRO_<KEY> at runtime.",
    category: "runtime-config",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/configuration#runtime-configuration",
    requires: { script: true, nitro: true },
    prefilter: { names: ["process"] },
  },
  create(ctx) {
    if (!isNitroServerFile(ctx)) return;
    return {
      MemberExpression(node: AnyNode) {
        if (ctx.helpers.getNodeName(node) !== "process.env") return;
        if (ctx.helpers.isTypeOnlyContext(node)) return;
        const parent = node.parent ?? node.__doctorParent;
        const key =
          parent?.type === "MemberExpression" && parent.object === node
            ? (parent.property?.name ?? parent.property?.value)
            : undefined;
        // NODE_ENV is the build mode libraries read; import.meta.dev says the same in app code.
        if (key === "NODE_ENV") return;
        report(
          ctx,
          node,
          "nitro/runtime/no-process-env-in-server",
          "warn",
          "runtime-config",
          key
            ? `process.env.${key} is read directly in Nitro server code.`
            : "process.env is read directly in Nitro server code.",
          "Declare the setting in runtimeConfig and read it with useRuntimeConfig().",
        );
      },
    };
  },
});
