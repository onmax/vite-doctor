import { AnyNode, createRule, isRuntimeAppFile, report } from "./shared.js";

export const noPlainEnvInAppCode = createRule({
  meta: {
    id: "nuxt/runtime/no-plain-env-in-app-code",
    title: "Use runtimeConfig instead of process.env in app code",
    category: "runtime-config",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isRuntimeAppFile(ctx)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.getNodeName(node) !== "process.env") return;
        report(
          ctx,
          node,
          "nuxt/runtime/no-plain-env-in-app-code",
          "error",
          "runtime-config",
          "process.env is not the public runtime contract for Nuxt app code.",
          "Expose values through runtimeConfig.public and read them with useRuntimeConfig().",
        );
      },
    };
  },
});
